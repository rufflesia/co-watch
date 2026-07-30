importScripts('socket.io.js');

const SERVER_URL = "http://localhost:3000";
let socket = null;

// MV3 Service Worker'ı hayatta tutmak için (Keep-Alive) Ping
chrome.alarms.create("keepAlive", { periodInMinutes: 0.3 });
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "keepAlive" && socket && socket.connected) {
        // SW'yi uyanık tutmak için boş bir işlem
    }
});

function initSocket() {
    if (socket) return;

    socket = io(SERVER_URL, { 
        transports: ['websocket'],
        secure: true,
        upgrade: true,
        reconnection: true,
        reconnectionAttempts: Infinity
    });

    socket.on("connect", () => {
        broadcastToContentScript({ action: "SYSTEM_MESSAGE", msg: { text: "Sunucuya arka plandan başarıyla bağlanıldı!" } });
        
        // YENİ: SW baştan başladığında eski bağlantıyı otomatik olarak onar
        chrome.storage.local.get(['savedRoomId', 'savedNickname'], (res) => {
            if (res.savedRoomId && res.savedNickname) {
                socket.emit('joinRoom', { roomId: res.savedRoomId, nickname: res.savedNickname });
            }
        });
    });

    socket.on("connect_error", (err) => {
        broadcastToContentScript({ action: "SYSTEM_ERROR", msg: { message: "Sunucu uykuda veya kapalı..." } });
    });

    socket.on('executeCommand', (cmd) => {
        broadcastToContentScript({ action: "EXECUTE_CMD", cmd });
    });

    socket.on('newMessage', (msg) => {
        broadcastToContentScript({ action: "NEW_MESSAGE", msg });
    });

    socket.on('systemMessage', (msg) => {
        broadcastToContentScript({ action: "SYSTEM_MESSAGE", msg });
    });

    socket.on('systemError', (msg) => {
        broadcastToContentScript({ action: "SYSTEM_ERROR", msg });
    });

    socket.on('typingIndicator', (data) => {
        broadcastToContentScript({ action: "TYPING_INDICATOR", nickname: data.nickname });
    });

    socket.on('userListUpdate', (users) => {
        broadcastToContentScript({ action: "USER_LIST_UPDATE", users });
    });

    socket.on('userTimesUpdate', (times) => {
        broadcastToContentScript({ action: "USER_TIMES_UPDATE", times });
    });

    socket.on('newAdminAssigned', (data) => {
        broadcastToContentScript({ action: "NEW_ADMIN_ASSIGNED", data });
    });

    socket.on('settingsUpdated', (settings) => {
        broadcastToContentScript({ action: "SETTINGS_UPDATED", settings });
    });

    socket.on('redirectForce', (data) => {
        broadcastToContentScript({ action: "REDIRECT_FORCE", data });
    });
}

function broadcastToContentScript(message) {
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
            if (tab.url && tab.url.match(/amazon|primevideo|youtube|dizibox|fullhdfilmizlesene|rapidvid/i)) {
                chrome.tabs.sendMessage(tab.id, message, () => {
                    if (chrome.runtime.lastError) { /* Pasif sekmeleri yoksay */ }
                });
            }
        });
    });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    initSocket();

    if (!socket) {
        sendResponse({ success: false, message: "Sunucu bağlantısı kurulamadı." });
        return true;
    }

    if (request.action === "OUT_CREATE_ROOM") {
        socket.emit('createRoom', request.data, (res) => sendResponse(res));
    }
    else if (request.action === "OUT_JOIN_ROOM") {
        socket.emit('joinRoom', request.data, (res) => sendResponse(res));
    }
    else if (request.action === "OUT_SYNC_TIME") {
        socket.emit('syncTime', request.data);
    }
    else if (request.action === "OUT_USER_ACTION") {
        socket.emit('userAction', request.data);
    }
    else if (request.action === "OUT_BUFFER_STATE") {
        socket.emit('bufferState', request.data);
    }
    else if (request.action === "OUT_SEND_MESSAGE") {
        socket.emit('sendMessage', request.data);
    }
    else if (request.action === "OUT_TYPING") {
        socket.emit('typing', request.data);
    }
    else if (request.action === "OUT_LEAVE_ROOM") {
        socket.emit('leaveRoom', request.data);
    }
    else if (request.action === "OUT_AD_PLAYING") {
        socket.emit('adPlaying', request.data);
    }
    // EKSİK OLAN KISIM BURASIYDI: Iframe'in üst sayfanın URL'sini almasını sağlar
    else if (request.action === "GET_TOP_URL") {
        sendResponse({ url: sender.tab ? sender.tab.url : "" });
    }
    else if (request.action === "TOGGLE_THEATER_MODE") {
        if (sender.tab) chrome.tabs.sendMessage(sender.tab.id, { action: "DO_TOGGLE_THEATER_MODE" });
    }
    else if (request.action === "EXIT_THEATER_MODE") {
        if (sender.tab) chrome.tabs.sendMessage(sender.tab.id, { action: "DO_EXIT_THEATER_MODE" });
    }
    else if (request.action === "OUT_REMOTE_LOG") {
        if (socket && socket.connected) {
            socket.emit('clientRemoteLog', request.data);
        }
    }
    
    // Asenkron sendResponse kullanımı için return true zorunludur
    return true; 
});

// ============================================================================
// ÜST SAYFA URL TAKİBİ (SPA navigasyonlarında iframe'lerin haberdar olması için)
// ============================================================================
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url && tab.url && tab.url.match(/dizibox|vidmoly|upstream|molystream|fullhdfilmizlesene|rapidvid/i)) {
        chrome.tabs.sendMessage(tabId, {
            action: "TOP_URL_CHANGED",
            url: changeInfo.url
        }).catch(() => {});
    }
});

// ============================================================================
// NETWORK SNIFFER (AĞ DİNLEYİCİSİ)
// ============================================================================
chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        const url = details.url;

        if (url.includes("/interstitial/") || url.includes("getVideoAds")) {
            chrome.tabs.sendMessage(details.tabId, { action: "AMAZON_AD_DETECTED" }).catch(() => {});
            return;
        }

        if (url.includes("GetVodPlaybackResources")) {
            try {
                const urlObj = new URL(url);
                const extractedVideoId = urlObj.searchParams.get("titleId");

                if (extractedVideoId) {
                    chrome.tabs.sendMessage(details.tabId, {
                        action: "NETWORK_VIDEO_ID_DETECTED",
                        data: { videoId: extractedVideoId, platform: "amazon" }
                    }).catch(() => {});
                }
            } catch (e) {}
        }
        
        else if (url.includes("youtube.com/youtubei/v1/player") || url.includes("youtube.com/api/stats/watchtime")) {
            const docidMatch = url.match(/docid=([^&]+)/) || url.match(/video_id=([^&]+)/);
            if (docidMatch) {
                chrome.tabs.sendMessage(details.tabId, {
                    action: "NETWORK_VIDEO_ID_DETECTED",
                    data: { videoId: docidMatch[1], platform: "youtube" }
                }).catch(() => {});
            }
        }
    },
    { 
        urls: [
            "*://*.primevideo.com/*", 
            "*://*.amazon.com/*",
            "*://*.amazon.com.tr/*", 
            "*://*.youtube.com/*",
            "*://*.akamaihd.net/*", 
            "*://*.dizibox.live/*", 
            "*://*.cloudfront.net/*"   
        ] 
    },
    ["requestBody"] 
);
