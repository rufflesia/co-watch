document.addEventListener('DOMContentLoaded', () => {
    const viewSetup = document.getElementById('view-setup');
    const viewActive = document.getElementById('view-active');
    const nickInput = document.getElementById('nickname');
    const roomIdInput = document.getElementById('room-id');
    const activeRoomIdDisplay = document.getElementById('active-room-id');
    const statusMsg = document.getElementById('status-msg');

    chrome.storage.local.get(['savedRoomId', 'savedNickname'], (res) => {
        if (res.savedNickname) nickInput.value = res.savedNickname;
        
        // YENİ: Kapanmış odanın arayüzde görünmemesi için sunucuyu yoksaymıyoruz, önce test ediyoruz
        if (res.savedRoomId && res.savedNickname) {
            chrome.runtime.sendMessage({
                action: "OUT_JOIN_ROOM",
                data: { roomId: res.savedRoomId, nickname: res.savedNickname }
            }, (response) => {
                if (response && response.success) {
                    viewSetup.classList.remove('active-view');
                    viewActive.classList.add('active-view');
                    activeRoomIdDisplay.textContent = res.savedRoomId;
                } else {
                    chrome.storage.local.remove(['savedRoomId']);
                }
            });
        }
    });

    function showStatus(msg, color = "#aaa") {
        statusMsg.textContent = msg;
        statusMsg.style.color = color;
        setTimeout(() => { statusMsg.textContent = ''; }, 3000);
    }

   function verifyAndSend(actionType, roomId, nickname) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tab = tabs[0];
            if (!tab || !tab.url.match(/amazon|primevideo|youtube|dizibox|fullhdfilmizlesene|rapidvid/i)) {
                showStatus("Önce desteklenen bir video sitesi açın!", "#ff4444");
                return;
            }

            chrome.tabs.sendMessage(tab.id, { action: "GET_CURRENT_METADATA" }, (response) => {
                
                // YENİ: Sayfadan yanıt gelmese bile URL'den platformu tahmin et (Unknown kalmasın)
                let fallbackPlatform = "unknown";
                if (tab.url.match(/amazon|primevideo/i)) fallbackPlatform = "amazon";
                else if (tab.url.match(/youtube/i)) fallbackPlatform = "youtube";
                else if (tab.url.match(/dizibox|vidmoly|upstream|molystream|fullhdfilmizlesene|rapidvid/i)) fallbackPlatform = "dizibox";

                let videoData = { platform: fallbackPlatform, videoId: null, url: tab.url };
                
                if (response && response.metadata) {
                    videoData = response.metadata;
                }

                chrome.runtime.sendMessage({
                    action: actionType,
                    data: { 
                        roomId, 
                        nickname, 
                        platform: videoData.platform, 
                        videoId: videoData.videoId, 
                        url: videoData.url 
                    }
                }, (serverResponse) => {
                    if (serverResponse && serverResponse.success) {
                        chrome.storage.local.set({ savedRoomId: roomId, savedNickname: nickname }, () => {
                            chrome.tabs.sendMessage(tab.id, { action: "FORCE_UI_STATE", actionType, roomId, nickname, response: serverResponse });
                            viewSetup.classList.remove('active-view');
                            viewActive.classList.add('active-view');
                            activeRoomIdDisplay.textContent = roomId;
                            window.close();
                        });
                    } else {
                        showStatus(serverResponse?.message || "Sunucu odada hata bildirdi!", "#ff4444");
                    }
                });
            });
        });
    }

    document.getElementById('btn-create').addEventListener('click', () => {
        const nick = nickInput.value.trim() || "Yusuf";
        const newRoom = "CW-" + Math.random().toString(36).substring(2, 8).toUpperCase();
        navigator.clipboard.writeText(newRoom);
        verifyAndSend("OUT_CREATE_ROOM", newRoom, nick);
    });

    document.getElementById('btn-join').addEventListener('click', () => {
        const nick = nickInput.value.trim() || "Misafir";
        const room = roomIdInput.value.trim().toUpperCase();
        if (!room) return showStatus("Oda kodu boş olamaz!", "#ff4444");
        verifyAndSend("OUT_JOIN_ROOM", room, nick);
    });

    document.getElementById('btn-leave').addEventListener('click', () => {
        chrome.storage.local.remove(['savedRoomId']);
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if(tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { action: "LEAVE_ROOM" });
        });
        viewActive.classList.remove('active-view');
        viewSetup.classList.add('active-view');
        showStatus("Odadan çıkıldı.", "#0f0");
    });

    document.getElementById('btn-show-chat').addEventListener('click', () => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if(tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { action: "SHOW_CHAT" });
        });
    });
});

const updateBtn = document.getElementById('btn-update');

    chrome.storage.local.get(['hasUpdate', 'newVer', 'zipUrl'], (res) => {
        if (res.hasUpdate && res.zipUrl) {
            updateBtn.style.display = 'block';
            updateBtn.innerText = `🚀 ${res.newVer} Sürümüne Güncelle`;
            
            updateBtn.addEventListener('click', () => {
                // ZIP dosyasını indir
                chrome.downloads.download({
                    url: res.zipUrl,
                    filename: "co-watch-${res.newVer}.zip"
                });
                
                // İndirme başladıktan sonra kullanıcıya ne yapacağını söyle
                alert("Güncel sürüm (ZIP) indiriliyor!\n\n1. İnen dosyayı klasöre çıkartın.\n2. Mevcut eklenti klasörünün üzerine yazın.\n3. chrome://extensions sayfasından eklentiyi yenile (Reload) butonuna basın.");
                
                // İkon bildirimini temizle
                chrome.action.setBadgeText({ text: "" });
                chrome.storage.local.remove(['hasUpdate', 'newVer', 'zipUrl']);
                updateBtn.style.display = 'none';
            });
        }
    });
