const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

app.get('/', (req, res) => {
    res.send('Co-Watch Akıllı Sunucusu Ayakta ve Çalışıyor!');
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {};

function broadcastUserList(roomId) {
    if (rooms[roomId]) {
        const activeUsers = Object.values(rooms[roomId].users).filter(u => u.isOnline).map(u => ({
            nickname: u.nickname,
            role: u.role,
            isBuffering: u.isBuffering,
            lastTime: u.lastTime || 0
        }));
        io.to(roomId).emit('userListUpdate', activeUsers);
    }
}

function checkAndDestroyRoom(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    
    const onlineUsers = Object.values(room.users).filter(u => u.isOnline);
    if (onlineUsers.length === 0) {
        console.log(`🗑️ Oda boşaldı: ${roomId}. 60 saniye içinde kalıcı olarak silinecek...`);
        room.destroyTimer = setTimeout(() => {
            console.log(`💥 Oda silindi ve bellek temizlendi: ${roomId}`);
            delete rooms[roomId];
        }, 60000);
    }
}

io.on('connection', (socket) => {
    console.log(`🟢 Yeni bağlantı: ${socket.id}`);
    // ==========================================================
    // 📡 GİZLİ TELEMETRİ TÜNELİ (İstemcideki logları terminale basar)
    // ==========================================================
    
    socket.on('createRoom', ({ roomId, platform, videoId, url, nickname }, callback) => {
        rooms[roomId] = {
            adminId: socket.id,
            settings: { maxMessages: 100, isFastMode: false, lockVideo: false },
            videoState: { platform, videoId, url, title: "", time: 0, isPlaying: false },
            chatHistory: [],
            users: {},
            bufferingTimer: null,
            wasPlayingBeforeBuffer: false,
            
            isTransitioning: false,
            transitionTimeout: null,
            syncLocked: false,
            actionHistory: []
        };
        
        socket.join(roomId);
        if (rooms[roomId].destroyTimer) {
            clearTimeout(rooms[roomId].destroyTimer);
            rooms[roomId].destroyTimer = null;
        }
        rooms[roomId].users[socket.id] = { 
            id: socket.id, 
            nickname, 
            role: 'admin', 
            isOnline: true, 
            tolerance: 2.0, 
            corrections: 0, 
            isBuffering: false, 
            hasSuccessfullySynced: true
        };
        
        broadcastUserList(roomId);
        if (callback) callback({ success: true, isHost: true, role: 'admin', chatHistory: [], roomState: rooms[roomId].videoState });
    });

    socket.on('joinRoom', ({ roomId, nickname }, callback) => {
        const room = rooms[roomId];
        if (room) {
            socket.join(roomId);
            if (room.destroyTimer) {
                clearTimeout(room.destroyTimer);
                room.destroyTimer = null;
            }

            // YENİ: Kalıcı Kimlik Kontrolü (Sayfa yenileyen/bölüm atlayan kullanıcıyı tanı)
            let existingKey = Object.keys(room.users).find(k => room.users[k].nickname === nickname);

            if (existingKey) {
                // Kullanıcı bulundu! Eski verilerini yeni soketine taşıyoruz.
                // Bu sayede "hasSuccessfullySynced" (ben zaten senkronum) statüsü korunuyor.
                room.users[socket.id] = { ...room.users[existingKey], id: socket.id, isOnline: true };
                
                // Eski soket kaydını sil
                if (existingKey !== socket.id) delete room.users[existingKey];
                
                // Eğer sayfa yenileyen kişi Admin idiyse, Adminlik ID'sini yeni soketle güncelle
                if (room.adminId === existingKey) room.adminId = socket.id;
            } else {
                // Yepyeni biri geldi, onu sıfırdan misafir olarak kaydet
                room.users[socket.id] = { 
                    id: socket.id, nickname: nickname || "Misafir", role: 'guest', isOnline: true, tolerance: 2.0, corrections: 0, isBuffering: false, hasSuccessfullySynced: false
                };
            }
            
            // Eğer önceden odadaysa "tekrar bağlandı", yeniyse "katıldı" yazdır
            const isReconnecting = !!existingKey;
            socket.to(roomId).emit('systemMessage', { type: 'system', text: `${nickname} odaya ${isReconnecting ? 'tekrar bağlandı.' : 'katıldı.'}` });
            
            broadcastUserList(roomId);
            
            if (callback) callback({ 
                success: true, 
                roomState: room.videoState, 
                settings: room.settings, 
                chatHistory: room.chatHistory, 
                role: room.users[socket.id].role,
                activeUsers: Object.values(room.users).map(u => ({
                    nickname: u.nickname, role: u.role, isBuffering: u.isBuffering, lastTime: u.lastTime || 0
                }))
            });
        } else {
            if (callback) callback({ success: false, message: "Oda bulunamadı veya kapatılmış." });
        }
    });
    socket.on('adPlaying', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;
        const user = room.users[socket.id];
        
        if (!room.isTransitioning) {
            io.to(data.roomId).emit('executeCommand', { action: 'pause', time: room.videoState.time, videoId: room.videoState.videoId });
            io.to(data.roomId).emit('systemMessage', { type: 'system', text: `📺 ${user.nickname} için Amazon Reklamı arasına girildi. Bekleniyor...` });
        }
    });

    socket.on('syncTime', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;
        const user = room.users[socket.id];
        if (!user) return;

        if (room.videoState.platform === "unknown" && data.platform && data.platform !== "unknown") {
            room.videoState.platform = data.platform;
        }

        // YENİ: Platform İhlali Koruması ve Link Atma İşlemi (Buradan chate link düşecek)
        if (room.videoState.platform && data.platform && data.platform !== "unknown" && data.platform !== room.videoState.platform) {
            socket.emit('systemError', {
                message: `Bu oda <b>"${room.videoState.platform}"</b> platformu için kuruldu. Farklı bir platformdan katılamazsınız.<br><br><a href="${room.videoState.url}" target="_blank" style="color:#ff9900; text-decoration:underline; font-weight:bold; cursor:pointer;">🎥 Doğru videoya gitmek için tıklayın</a>`
            });
            if (data.videoId) socket.emit('executeCommand', { action: 'pause', time: data.time, videoId: data.videoId });
            return;
        }

        user.lastTime = data.time;
        user.lastVideoId = data.videoId;

        if (!room.videoState.videoId || room.videoState.videoId === "unknown") {
            room.videoState.platform = data.platform;
            room.videoState.videoId = data.videoId;
            room.videoState.url = data.url;
            room.videoState.title = data.title;
            user.hasSuccessfullySynced = true;
        }

        let isIdMismatch = (data.videoId && data.videoId !== room.videoState.videoId);
      

      

        if (isIdMismatch && room.videoState.platform === 'amazon') {
            const guestUrlHasHostId = data.url && data.url.includes(room.videoState.videoId);
            const hostUrlHasGuestId = room.videoState.url && room.videoState.url.includes(data.videoId);
            
            if (guestUrlHasHostId || hostUrlHasGuestId) {
                isIdMismatch = false; 
                
                if (data.videoId && room.videoState.videoId && data.videoId.length > room.videoState.videoId.length) {
                    room.videoState.videoId = data.videoId;
                    room.videoState.url = data.url;
                    user.hasSuccessfullySynced = true;
                } else {
                    data.videoId = room.videoState.videoId; 
                    user.lastVideoId = room.videoState.videoId;
                }
            }
        }

        if (isIdMismatch) {
            
            if (!user.hasSuccessfullySynced) {
                socket.emit('redirectForce', { url: room.videoState.url, videoId: room.videoState.videoId, platform: room.videoState.platform });
                
                if (!room.isTransitioning) {
                    room.isTransitioning = true;
                    // YENİ: Sonsuz Geçiş Bekleme Süresini Sınırla
                    if(room.transitionTimeout) clearTimeout(room.transitionTimeout);
                    room.transitionTimeout = setTimeout(() => {
                        if (room.isTransitioning) {
                            room.isTransitioning = false;
                            io.to(data.roomId).emit('executeCommand', { action: 'play', time: room.videoState.time, videoId: room.videoState.videoId });
                        }
                    }, 25000);

                    io.to(data.roomId).emit('executeCommand', { action: 'pause', time: room.videoState.time, videoId: room.videoState.videoId });
                    io.to(data.roomId).emit('systemMessage', { type: 'system', text: `⏳ ${user.nickname} doğru videoya çekiliyor. Herkes için bekleniyor...` });
                }
                return; 
            }

            if (!room.settings.lockVideo) {
                room.videoState.platform = data.platform;
                room.videoState.videoId = data.videoId;
                room.videoState.url = data.url;
                room.videoState.title = data.title;
                room.videoState.time = data.time;
                room.isTransitioning = true; 
                
                if(room.transitionTimeout) clearTimeout(room.transitionTimeout);
                room.transitionTimeout = setTimeout(() => {
                    if (room.isTransitioning) {
                        room.isTransitioning = false;
                        io.to(data.roomId).emit('executeCommand', { action: 'play', time: room.videoState.time, videoId: room.videoState.videoId });
                    }
                }, 25000);

                Object.values(room.users).forEach(u => {
                    if (u.id !== socket.id) u.hasSuccessfullySynced = false;
                });

                socket.to(data.roomId).emit('redirectForce', { url: data.url, videoId: data.videoId, platform: data.platform });
                io.to(data.roomId).emit('executeCommand', { action: 'pause', time: room.videoState.time, videoId: room.videoState.videoId });
                io.to(data.roomId).emit('systemMessage', { type: 'system', text: `🔄 ${user.nickname} yeni videoya geçti. Geride kalanlar oraya çekiliyor...` });
                return;
            }
        } 
        else if (!data.videoId || data.videoId === room.videoState.videoId) {
            user.hasSuccessfullySynced = true;
            
            if (room.isTransitioning) {
                const allOnlineSynced = Object.values(room.users).filter(u => u.isOnline).every(u => u.hasSuccessfullySynced);
                
                if (allOnlineSynced) {
                    room.isTransitioning = false;
                    if(room.transitionTimeout) clearTimeout(room.transitionTimeout);
                    io.to(data.roomId).emit('systemMessage', { type: 'system', text: `✅ Herkes videoya ulaştı! Oynatma devam ediyor.` });
                    io.to(data.roomId).emit('executeCommand', { action: 'play', time: room.videoState.time, videoId: room.videoState.videoId });
                }
            }
        }

        if (!room.isTransitioning) {
            if (data.isPlaying && Math.abs(data.time - room.videoState.time) <= user.tolerance) {
                room.videoState.time = Math.max(room.videoState.time, data.time);
            } 
            else if (data.time < room.videoState.time - user.tolerance || data.time > room.videoState.time + user.tolerance) {
                socket.emit('executeCommand', { action: 'seek', time: room.videoState.time, videoId: room.videoState.videoId });
                
                user.corrections += 1;
                if (user.corrections > 3 && user.tolerance === 2.0) {
                    user.tolerance = 4.0;
                    socket.emit('systemError', { message: "Bağlantınız zayıf. İzleme keyfiniz için esneklik artırıldı." });
                    setTimeout(() => { user.corrections = 0; user.tolerance = 2.0; }, 60000);
                }
            }
        }
    });

    socket.on('userAction', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;

        if (room.isTransitioning || room.syncLocked) return;

        const now = Date.now();
        room.actionHistory.push(now);
        room.actionHistory = room.actionHistory.filter(timestamp => now - timestamp < 1500);

        if (room.actionHistory.length >= 4) {
            room.syncLocked = true;
            room.actionHistory = [];
            
            io.to(data.roomId).emit('executeCommand', { action: 'pause', time: room.videoState.time, videoId: room.videoState.videoId });
            io.to(data.roomId).emit('systemMessage', { type: 'system', text: `⚠️ Play/Pause çakışması tespit edildi. Senkronizasyon toparlanıyor...` });

            setTimeout(() => {
                io.to(data.roomId).emit('executeCommand', { action: 'play', time: room.videoState.time, videoId: room.videoState.videoId });
                room.syncLocked = false;
            }, 1500);
            
            return;
        }

        room.videoState.time = data.time;
        room.videoState.isPlaying = data.isPlaying;
        
        socket.to(data.roomId).emit('executeCommand', { action: data.action, time: data.time, videoId: room.videoState.videoId });
        
        const nick = room.users[socket.id]?.nickname || "Biri";
        if (data.action === 'pause') {
            io.to(data.roomId).emit('systemMessage', { type: 'system', text: `⏸ ${nick} videoyu durdurdu.` });
        } else if (data.action === 'play') {
            io.to(data.roomId).emit('systemMessage', { type: 'system', text: `▶ ${nick} videoyu başlattı.` });
            Object.values(room.users).forEach(u => u.corrections = 0);
        }
    });

    socket.on('bufferState', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;
        const user = room.users[socket.id];
        if (!user) return;
        
        if (room.isTransitioning) return; 

        if (data.isBuffering) {
            user.isBuffering = true;
            if (!room.bufferingTimer) {
                room.wasPlayingBeforeBuffer = room.videoState.isPlaying;
                
                room.bufferingTimer = setTimeout(() => {
                    const stuckUsers = Object.values(room.users).filter(u => u.isBuffering && u.isOnline);
                    if (stuckUsers.length > 0) {
                        const names = stuckUsers.map(u => u.nickname).join(', ');
                        io.to(data.roomId).emit('executeCommand', { action: 'pause', time: room.videoState.time, videoId: room.videoState.videoId });
                        io.to(data.roomId).emit('systemMessage', { type: 'system', text: `⚠️ ${names} bekleniyor (Bağlantı zayıf)...` });
                    }
                }, 5000);
            }
        } else {
            user.isBuffering = false;
            const anyBuffering = Object.values(room.users).some(u => u.isBuffering && u.isOnline);
            if (!anyBuffering) {
                if (room.bufferingTimer) {
                    clearTimeout(room.bufferingTimer);
                    room.bufferingTimer = null;
                }
                
                if (room.wasPlayingBeforeBuffer) {
                    io.to(data.roomId).emit('executeCommand', { action: 'play', time: room.videoState.time, videoId: room.videoState.videoId });
                }
            }
        }
    });

    socket.on('sendMessage', (data) => {
        const room = rooms[data.roomId];
        if (room) {
            const messageObj = { senderId: socket.id, nickname: room.users[socket.id]?.nickname || "Misafir", text: data.message };
            room.chatHistory.push(messageObj);
            if (room.chatHistory.length > room.settings.maxMessages) room.chatHistory.shift();
            io.to(data.roomId).emit('newMessage', messageObj);
        }
    });

    socket.on('leaveRoom', (data) => {
        const room = rooms[data.roomId];
        if (room && room.users[socket.id]) {
            const leftUser = room.users[socket.id].nickname;
            delete room.users[socket.id]; 
            socket.leave(data.roomId);
            
            io.to(data.roomId).emit('systemMessage', { type: 'system', text: `👋 ${leftUser} odadan tamamen ayrıldı.` });
            broadcastUserList(data.roomId);
            
            checkAndDestroyRoom(data.roomId); 
        }
    });

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            if (room.users[socket.id]) {
                room.users[socket.id].isOnline = false;
                room.users[socket.id].isBuffering = false;
                io.to(roomId).emit('systemMessage', { type: 'system', text: `${room.users[socket.id].nickname} çevrimdışı oldu.` });
                
                if (room.adminId === socket.id) {
                    const onlineUsers = Object.values(room.users).filter(u => u.isOnline);
                    if (onlineUsers.length > 0) {
                        const newAdmin = onlineUsers[0];
                        room.adminId = newAdmin.id;
                        newAdmin.role = 'admin';
                        io.to(roomId).emit('newAdminAssigned', { newAdminId: newAdmin.id, nickname: newAdmin.nickname });
                        io.to(roomId).emit('systemMessage', { type: 'system', text: `👑 Kurucu düştü. Yeni yönetici: ${newAdmin.nickname}` });
                    }
                }
                
                if (room.isTransitioning) {
                    const allOnlineSynced = Object.values(room.users).filter(u => u.isOnline).every(u => u.hasSuccessfullySynced);
                    if (allOnlineSynced && Object.values(room.users).filter(u => u.isOnline).length > 0) {
                        clearTimeout(room.transitionTimeout);
                        room.isTransitioning = false;
                        io.to(roomId).emit('systemMessage', { type: 'system', text: `✅ Çevrimiçi olan herkes videoya ulaştı! Oynatma devam ediyor.` });
                        io.to(roomId).emit('executeCommand', { action: 'play', time: room.videoState.time, room: room.videoState.videoId });
                    }
                }

                broadcastUserList(roomId);
                checkAndDestroyRoom(roomId);
            }
        }
    });
});

setInterval(() => {
    for (const roomId in rooms) {
        const room = rooms[roomId];
        const timeData = Object.values(room.users).filter(u => u.isOnline).map(u => ({ nickname: u.nickname, lastTime: u.lastTime || 0 }));
        if (timeData.length > 0) io.to(roomId).emit('userTimesUpdate', timeData);
    }
}, 3000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Co-Watch Akıllı Sunucusu ${PORT} portunda çalışıyor.`);
});