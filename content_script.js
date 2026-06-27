// ============================================================================
// CO-WATCH CORE V4.5 - SEAMLESS THEATER MODE WITH TOGGLE & ESC SUPPORT
// ============================================================================
const PLATFORM_SELECTORS = {
    amazon: { title: '.atvwebplayersdk-title-text', subtitle: '.atvwebplayersdk-subtitle-text', playButton: '[data-testid="dp-atf-play-button"], [data-automation-id="dp-atf-play-button"]' },
    youtube: { title: 'h1.ytd-video-primary-info-renderer, h1.title yt-formatted-string' },
    dizibox: { title: '.entry-title, h1' }
};

function detectPlatformFromUrl(url) {
    if (url.includes("amazon") || url.includes("primevideo")) return "amazon";
    if (url.includes("youtube")) return "youtube";
    if (url.match(/dizibox|vidmoly|upstream|molystream/i)) return "dizibox";
    return "unknown";
}

class VideoHandler {
    constructor(videoElement, roomId, uiController) {
        this.video = videoElement;
        this.roomId = roomId;
        this.ui = uiController;
        this.trackedSrc = videoElement.src;
        this.ignoreNext = { play: false, pause: false, seek: false };

        console.log(`🎬 Co-Watch: Handler initialized for ${this.constructor.name}`);
        this.bindListeners();
        this.hookMediaSession();
        setTimeout(() => this.updateMetadata(), 1000);
    }

    bindListeners() {
        this._onPlay = () => {
            if (this.ui.isTransitioning) { this.video.pause(); return; }
            if (this.ignoreNext.play) { this.ignoreNext.play = false; return; }
            this.emitAction('play');
        };
        this._onPause = () => {
            if (this.ignoreNext.pause) { this.ignoreNext.pause = false; return; }
            this.emitAction('pause');
        };
        this._onSeek = () => {
            if (this.ignoreNext.seek) { this.ignoreNext.seek = false; return; }
            this.emitAction('seek');
        };
        this._onWaiting = () => { if (!this.ignoreNext.play && !this.ignoreNext.pause) this.emitBuffer(true); };
        this._onPlaying = () => { if (!this.ignoreNext.play && !this.ignoreNext.pause) this.emitBuffer(false); };
        this._onTimeUpdate = () => {
            this.ui.updateProgress(this.video.currentTime, this.video.duration);
            this.ui.checkTransitionState(this);
        };

        this.video.addEventListener('play', this._onPlay);
        this.video.addEventListener('pause', this._onPause);
        this.video.addEventListener('seeking', this._onSeek);
        this.video.addEventListener('waiting', this._onWaiting);
        this.video.addEventListener('playing', this._onPlaying);
        this.video.addEventListener('timeupdate', this._onTimeUpdate);
    }

    hookMediaSession() {
        if ('mediaSession' in navigator) {
            navigator.mediaSession.setActionHandler('play', () => { this.video.play(); });
            navigator.mediaSession.setActionHandler('pause', () => { this.video.pause(); });
        }
    }

    emitAction(action) {
        if (!this.roomId || this.ui.isTransitioning || this.ui.isAdPlaying) return;
        const videoData = this.extractMetadata();
        chrome.runtime.sendMessage({
            action: "OUT_USER_ACTION",
            data: { roomId: this.roomId, action: action, time: this.video.currentTime, isPlaying: !this.video.paused, videoId: videoData.videoId }
        });
    }

    emitBuffer(isBuffering) {
        if (!this.roomId || this.ui.isTransitioning || this.ui.isAdPlaying) return;
        chrome.runtime.sendMessage({ action: "OUT_BUFFER_STATE", data: { roomId: this.roomId, isBuffering } });
    }

    executeCommand(cmd) {
        if (Math.abs(this.video.currentTime - cmd.time) > 1.2) {
            this.ignoreNext.seek = true;
            this.video.currentTime = cmd.time;
            this.ui.syncLock = true;
            setTimeout(() => { this.ui.syncLock = false; }, 2500);
        }
        if (cmd.action === 'play' && this.video.paused) {
            this.ignoreNext.play = true;
            const playPromise = this.video.play();
            if (playPromise !== undefined) playPromise.catch(() => { this.ignoreNext.play = false; });
        }
        else if (cmd.action === 'pause' && !this.video.paused) {
            this.ignoreNext.pause = true;
            this.video.pause();
        }
    }

    updateMetadata() {
        if (!this.roomId) return;
        const data = this.extractMetadata();
        this.ui.setTitle(data.title);
        if (!this.video.paused && !this.ui.isTransitioning && !this.ui.syncLock && !this.ui.isAdPlaying) {
            chrome.runtime.sendMessage({
                action: "OUT_SYNC_TIME",
                data: { roomId: this.roomId, time: this.video.currentTime, isPlaying: true, platform: data.platform, videoId: data.videoId, url: data.url }
            });
        }
    }

    extractMetadata() { return { platform: 'unknown', videoId: null, url: window.location.href, title: 'Bilinmeyen Video' }; }

    destroy() {
        this.video.removeEventListener('play', this._onPlay);
        this.video.removeEventListener('pause', this._onPause);
        this.video.removeEventListener('seeking', this._onSeek);
        this.video.removeEventListener('waiting', this._onWaiting);
        this.video.removeEventListener('playing', this._onPlaying);
        this.video.removeEventListener('timeupdate', this._onTimeUpdate);
    }
}

class AmazonHandler extends VideoHandler {
    static lastClickedGTI = null;
    static interceptorBound = false;

    constructor(videoElement, roomId, uiController) {
        super(videoElement, roomId, uiController);
        AmazonHandler.initGTIInterceptor();
    }

    static initGTIInterceptor() {
        if (AmazonHandler.interceptorBound) return;
        document.addEventListener('click', (event) => {
            let transitionTriggered = false;
            const episodeContainer = event.target.closest('li, [class*="episode-container"], [class*="js-node-episode"], .tst-episode-container');
            if (episodeContainer) {
                const gtiInput = episodeContainer.querySelector('input[id^="selector-amzn1.dv.gti."]');
                if (gtiInput && gtiInput.id) { AmazonHandler.lastClickedGTI = gtiInput.id.replace('selector-', ''); transitionTriggered = true; }
            }
            const playButton = event.target.closest(PLATFORM_SELECTORS.amazon.playButton);
            if (playButton && playButton.href) {
                const dpMatch = playButton.href.match(/(?:dp|detail|video\/detail)\/([a-zA-Z0-9]+)/i);
                if (dpMatch) { AmazonHandler.lastClickedGTI = dpMatch[1]; transitionTriggered = true; }
            }
            if (transitionTriggered && window.coWatchInstance) window.coWatchInstance.enterTransitionMode(AmazonHandler.lastClickedGTI);
        }, true);
        AmazonHandler.interceptorBound = true;
    }

    extractMetadata() {
        const url = window.location.href;
        let videoId = window.coWatchInstance.globalNetworkGTI || AmazonHandler.lastClickedGTI;

        if (!videoId) {
            const hydrationScript = document.getElementById('dv-web-page-hydration-data');
            if (hydrationScript) {
                try {
                    const match = hydrationScript.textContent.match(/"playbackID"\s*:\s*"([^"]+)"/i) || hydrationScript.textContent.match(/"gti"\s*:\s*"([^"]+)"/i);
                    if (match) videoId = match[1];
                } catch (e) {}
            }
        }
        if (!videoId) {
            const gtiMatch = url.match(/gti=([^&]+)/);
            const dpMatch = url.match(/(?:dp|detail|video\/detail)\/([a-zA-Z0-9]+)/i);
            videoId = gtiMatch ? gtiMatch[1] : (dpMatch ? dpMatch[1] : null);
        }

        const titleEl = document.querySelector(PLATFORM_SELECTORS.amazon.title);
        const subtitleEl = document.querySelector(PLATFORM_SELECTORS.amazon.subtitle);
        let displayTitle = "Amazon Prime Video";
        if (titleEl) {
            displayTitle = titleEl.innerText;
            if (subtitleEl && subtitleEl.innerText) displayTitle += ` - ${subtitleEl.innerText}`;
        } else {
            displayTitle = document.title.replace("Prime Video: ", "").trim();
        }
        return { platform: 'amazon', videoId: videoId, url: url, title: displayTitle };
    }
}

class YouTubeHandler extends VideoHandler {
    extractMetadata() {
        const url = new URL(window.location.href);
        const titleEl = document.querySelector(PLATFORM_SELECTORS.youtube.title);
        return { platform: 'youtube', videoId: url.searchParams.get('v'), url: window.location.href, title: titleEl ? titleEl.innerText : document.title.replace(" - YouTube", "") };
    }
}

class DiziboxHandler extends VideoHandler {
    constructor(videoElement, roomId, uiController) {
        super(videoElement, roomId, uiController);
    }

    destroy() {
        super.destroy();
    }

    extractMetadata() {
        let actualUrl = window.coWatchInstance.topUrl || window.location.href;
        let videoId = "dizibox-video";
        try {
            const urlObj = new URL(actualUrl);
            videoId = urlObj.pathname.replace(/\/$/, '') || "generic-video";
        } catch (e) {}

        const titleEl = window === window.top ? document.querySelector(PLATFORM_SELECTORS.dizibox.title) : null;
        let displayTitle = titleEl ? titleEl.innerText : (document.title || "Dizi/Film İzleme");
        return { platform: 'dizibox', videoId: videoId, url: actualUrl, title: displayTitle };
    }
}

class CoWatchCore {
    constructor() {
        this.currentRoomId = null;
        this.currentUser = { nickname: "Misafir", role: "guest" };
        this.activeHandler = null;
        this.isMainFrame = (window === window.top);
        this.shadow = null;

        this.isTransitioning = false;
        this.targetTransitionId = null;
        this.transitionTimeout = null;
        this.syncLock = false;
        this.pendingCommand = null;
        this.globalNetworkGTI = null;
        this.isAdPlaying = false;

        this.topUrl = window.location.href;
        if (!this.isMainFrame) {
            chrome.runtime.sendMessage({ action: "GET_TOP_URL" }, (response) => {
                if (response && response.url) this.topUrl = response.url;
            });
        }

        if (this.isMainFrame) {
            this.injectGlobalStyles();
            this.injectUI();
        }

        this.handleNativeFullscreen();
        this.listenForBackgroundMessages();
        this.initVideoObserver();
        setInterval(() => this.pulseSync(), 1500);
    }

    injectGlobalStyles() {
        const style = document.createElement('style');
        style.textContent = `
            body.cw-theater-mode { overflow: hidden !important; background: #000 !important; }
            body.cw-theater-mode iframe[src*="molystream"],
            body.cw-theater-mode iframe[src*="vidmoly"],
            body.cw-theater-mode iframe[src*="upstream"],
            body.cw-theater-mode iframe[src*="king"] {
                position: fixed !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important;
                z-index: 2147483645 !important; border: none !important; background: #000 !important;
            }
        `;
        document.head.appendChild(style);
    }

    handleNativeFullscreen() {
        document.addEventListener('fullscreenchange', () => {
            if (!this.isMainFrame && document.fullscreenElement) {
                document.exitFullscreen().then(() => {
                    this.safeSendMessage({ action: "TOGGLE_THEATER_MODE" });
                }).catch(e => console.log(e));
            }
            else if (this.isMainFrame) {
                const host = document.getElementById('cowatch-root');
                if (!host) return;
                if (document.fullscreenElement) {
                    if (document.fullscreenElement.tagName !== 'IFRAME') {
                        document.fullscreenElement.appendChild(host);
                    }
                } else {
                    document.body.appendChild(host);
                    document.body.classList.remove('cw-theater-mode');
                }
            }
        });

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (this.isMainFrame) {
                    document.body.classList.remove('cw-theater-mode');
                    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
                } else {
                    this.safeSendMessage({ action: "EXIT_THEATER_MODE" });
                }
            }
        });
    }

    enterTransitionMode(targetVideoId) {
        if (!this.isTransitioning) console.log(`🛑 Co-Watch: Geçiş Modu (Mute) AKTİF.`);
        this.isTransitioning = true;
        this.targetTransitionId = targetVideoId;
        if (this.globalNetworkGTI !== targetVideoId) this.globalNetworkGTI = null;

        if (this.transitionTimeout) clearTimeout(this.transitionTimeout);
        this.transitionTimeout = setTimeout(() => {
            if (this.isTransitioning) {
                this.isTransitioning = false;
                this.targetTransitionId = null;
            }
        }, 8000);
    }

    exitTransitionMode() {
        if (this.isTransitioning) {
            if (this.transitionTimeout) clearTimeout(this.transitionTimeout);
            this.isTransitioning = false;
            this.targetTransitionId = null;
        }
    }

    checkTransitionState(handler) {
        if (!this.isTransitioning || !this.targetTransitionId) return;
        const data = handler.extractMetadata();
        if (data.videoId === this.targetTransitionId && handler.video.currentTime > 0.1 && !handler.video.paused) {
            this.exitTransitionMode();
        }
    }

    safeSendMessage(message, callback) {
        if (!chrome.runtime?.id) return;
        try { chrome.runtime.sendMessage(message, callback); } catch (e) {}
    }

    injectUI() {
        const cowatchHost = document.createElement('div');
        cowatchHost.id = 'cowatch-root';
        document.body.appendChild(cowatchHost);
        this.shadow = cowatchHost.attachShadow({ mode: 'open' });

        this.shadow.innerHTML = `
        <style>
            :host { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; --bg-glass: rgba(18, 18, 18, 0.85); --border-glass: rgba(255, 255, 255, 0.08); --text-main: #f0f0f0; --accent: #ff9900; --danger: #ff4444; }
            #cw-app { display: none; background: var(--bg-glass); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid var(--border-glass); color: var(--text-main); flex-direction: column; overflow: hidden; z-index: 2147483647; box-shadow: -5px 0 30px rgba(0,0,0,0.5); position: fixed; }
            .mode-compact { top: 20px; right: 20px; width: 340px; height: 500px; border-radius: 16px; }
            .mode-interactive { top: 0; right: -360px; width: 340px; height: 100vh; border-radius: 20px 0 0 20px; border-right: none; transition: right 0.3s ease; }
            .mode-interactive.show { right: 0; }
            #cw-hover-trigger { position: fixed; top: 0; right: 0; width: 30px; height: 100vh; z-index: 2147483646; display: none; }
            .mode-fixed { top: 0; right: 0; width: 340px; height: 100vh; border-radius: 0; border-left: 1px solid var(--border-glass); }
            #cw-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 15px; background: rgba(0,0,0,0.6); border-bottom: 1px solid var(--border-glass); }
            .mode-compact #cw-header { cursor: grab; }
            .mode-compact #cw-header:active { cursor: grabbing; }
            .cw-tabs { display: flex; gap: 15px; }
            .cw-tabs button { background: none; border: none; color: #777; cursor: pointer; padding: 0 0 5px 0; font-weight: bold; font-size: 15px; }
            .cw-tabs button.active { color: var(--accent); border-bottom: 2px solid var(--accent); }
            .copy-badge { background: rgba(255,153,0,0.1); border: 1px dashed var(--accent); color: var(--accent); padding: 4px 8px; border-radius: 6px; font-size: 11px; cursor: pointer; font-family: monospace; }
            .header-controls button { background: none; border: none; cursor: pointer; font-size: 16px; padding: 5px; color: white; opacity: 0.7; }
            #cw-body { flex: 1; display: flex; flex-direction: column; overflow: hidden; position: relative; }
            .cw-view { display: none; flex: 1; flex-direction: column; padding: 15px; overflow-y: auto; }
            .cw-view.active-view { display: flex; }
            #cw-chat-history { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding-right: 5px; }
            .cw-message { display: flex; flex-direction: column; max-width: 85%; }
            .cw-nick { font-size: 10px; color: #888; margin-bottom: 2px; }
            .cw-bubble { padding: 8px 12px; word-break: break-word; line-height: 1.4; }
            .msg-self { align-self: flex-end; }
            .msg-self .cw-bubble { background: var(--accent); color: #000; border-radius: 14px 14px 0 14px; font-weight: 500; }
            .msg-other { align-self: flex-start; }
            .msg-other .cw-bubble { background: rgba(255,255,255,0.1); color: #fff; border-radius: 0 14px 14px 14px; }
            .sys-msg { color: var(--accent); font-style: italic; font-size: 12px; text-align: center; margin: 5px 0; line-height: 1.5; }
            .sys-err { color: var(--danger); font-weight: bold; font-size: 11px; text-align: center; }
            #cw-input-area { display: flex; gap: 8px; position: relative; }
            #cw-chat-input { flex: 1; background: rgba(0,0,0,0.4); border: 1px solid #444; color: white; padding: 10px; border-radius: 8px; outline: none; }
            #btn-send { background: var(--accent); color: #000; font-weight: bold; border: none; border-radius: 8px; padding: 10px; cursor: pointer; }
            .user-li { display: flex; justify-content: space-between; align-items: center; padding: 10px; background: rgba(255,255,255,0.03); border-radius: 8px; margin-bottom: 8px; }
            .time-badge { background: rgba(255,153,0,0.2); color: var(--accent); padding: 4px 8px; border-radius: 12px; font-size: 11px; }
            .mod-btn-group { display: flex; gap: 5px; margin-bottom: 20px; }
            .mod-btn { flex: 1; background: #222; border: 1px solid #444; color: white; padding: 8px; border-radius: 6px; cursor: pointer; font-size: 12px; }
            .mod-btn.active { background: var(--accent); color: #000; font-weight: bold; }
            #cw-manual-bar-container { background: rgba(0,0,0,0.8); padding: 12px 15px; border-top: 1px solid var(--border-glass); }
            .controls-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 8px;}
            .ctrl-btn { background: rgba(255,255,255,0.1); color: white; border: none; border-radius: 4px; padding: 4px 8px; cursor: pointer; }
            #cw-progress-bg { flex: 1; height: 8px; background: #444; border-radius: 4px; position: relative; cursor: pointer; }
            #cw-progress-fill { height: 100%; background: var(--accent); width: 0%; border-radius: 4px; }
        </style>

        <div id="cw-app" class="mode-compact">
            <div id="cw-header">
                <div class="cw-tabs">
                    <button id="tab-chat" class="active">💬</button>
                    <button id="tab-users">👥</button>
                    <button id="tab-settings">⚙️</button>
                </div>
                <div class="header-controls">
                    <span id="cw-room-id" class="copy-badge">Bekleniyor</span>
                    <button id="btn-leave-ui">❌</button>
                </div>
            </div>
            <div id="cw-body">
                <div id="view-chat" class="cw-view active-view">
                    <div id="cw-chat-history"></div>
                    <div id="cw-input-area">
                        <input type="text" id="cw-chat-input" placeholder="Mesaj gönder...">
                        <button id="btn-send">➤</button>
                    </div>
                </div>
                <div id="view-users" class="cw-view"><div id="cw-user-list"></div></div>
                <div id="view-settings" class="cw-view">
                    <div class="mod-btn-group">
                        <button class="mod-btn active" data-mode="mode-compact">📱 Kompakt</button>
                        <button class="mod-btn" data-mode="mode-interactive">👉 İnteraktif</button>
                        <button class="mod-btn" data-mode="mode-fixed">📌 Sabit</button>
                    </div>
                </div>
                <div id="cw-manual-bar-container">
                    <div id="cw-video-title">Video aranıyor...</div>
                    <div class="controls-row">
                        <button id="btn-rewind" class="ctrl-btn">⏮ -10s</button>
                        <button id="btn-playpause" class="ctrl-btn">⏯</button>
                        <div id="cw-progress-bg"><div id="cw-progress-fill"></div></div>
                        <button id="btn-forward" class="ctrl-btn">+10s ⏭</button>
                    </div>
                    <div style="text-align:center; margin-top:5px;"><span id="cw-time-display" style="font-size:10px; color:#aaa;">00:00 / 00:00</span></div>
                </div>
            </div>
        </div>
        <div id="cw-hover-trigger"></div>
        `;
        this.bindUIEvents();
        this.checkAutoJoin();
    }

    bindUIEvents() {
        const app = this.shadow.getElementById('cw-app');
        const header = this.shadow.getElementById('cw-header');
        const chatInput = this.shadow.getElementById('cw-chat-input');

        const blockSocks = (e) => e.stopPropagation();
        chatInput.addEventListener('keydown', blockSocks);
        chatInput.addEventListener('keypress', blockSocks);
        chatInput.addEventListener('keyup', blockSocks);

        ['chat', 'users', 'settings'].forEach(tab => {
            this.shadow.getElementById(`tab-${tab}`).addEventListener('click', (e) => {
                this.shadow.querySelectorAll('.cw-tabs button').forEach(b => b.classList.remove('active'));
                this.shadow.querySelectorAll('.cw-view').forEach(v => v.classList.remove('active-view'));
                e.target.classList.add('active');
                this.shadow.getElementById(`view-${tab}`).classList.add('active-view');
            });
        });

        let isDragging = false, offsetX, offsetY;
        header.addEventListener('mousedown', (e) => {
            if (!app.classList.contains('mode-compact') || e.target.tagName.toLowerCase() === 'button') return;
            isDragging = true;
            offsetX = e.clientX - app.getBoundingClientRect().left;
            offsetY = e.clientY - app.getBoundingClientRect().top;
            document.body.style.userSelect = 'none';
        });
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            app.style.left = `${e.clientX - offsetX}px`;
            app.style.top = `${e.clientY - offsetY}px`;
        });
        document.addEventListener('mouseup', () => { isDragging = false; document.body.style.userSelect = ''; });

        this.shadow.querySelectorAll('.mod-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.shadow.querySelectorAll('.mod-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                const newMode = e.target.getAttribute('data-mode');
                app.className = newMode;
                this.shadow.getElementById('cw-hover-trigger').style.display = (newMode === 'mode-interactive') ? 'block' : 'none';
            });
        });

        this.shadow.getElementById('cw-hover-trigger').addEventListener('mouseenter', () => {
            if (app.classList.contains('mode-interactive')) app.classList.add('show');
        });
        app.addEventListener('mouseleave', () => {
            if (app.classList.contains('mode-interactive')) app.classList.remove('show');
        });

        this.shadow.getElementById('btn-leave-ui').onclick = () => {
            if (confirm("Odadan tamamen ayrılmak istediğinize emin misiniz?")) {
                chrome.storage.local.remove(['savedRoomId']);
                app.style.display = 'none';
                if (this.currentRoomId) this.safeSendMessage({ action: "OUT_LEAVE_ROOM", data: { roomId: this.currentRoomId } });
                this.currentRoomId = null;
                if (this.activeHandler) this.activeHandler.roomId = null;
            }
        };

        const sendMsg = () => {
            if (chatInput.value.trim() && this.currentRoomId) {
                this.safeSendMessage({ action: "OUT_SEND_MESSAGE", data: { roomId: this.currentRoomId, message: chatInput.value } });
                chatInput.value = '';
            }
        };
        this.shadow.getElementById('btn-send').onclick = sendMsg;
        chatInput.onkeypress = (e) => { if (e.key === 'Enter') { e.stopPropagation(); sendMsg(); } };

        this.shadow.getElementById('btn-playpause').onclick = () => {
            if (this.activeHandler && this.activeHandler.video) this.activeHandler.video.paused ? this.activeHandler.video.play() : this.activeHandler.video.pause();
        };
        this.shadow.getElementById('btn-rewind').onclick = () => { if (this.activeHandler) this.activeHandler.video.currentTime -= 10; };
        this.shadow.getElementById('btn-forward').onclick = () => { if (this.activeHandler) this.activeHandler.video.currentTime += 10; };
    }

    checkAutoJoin() {
        chrome.storage.local.get(['savedRoomId', 'savedNickname'], (res) => {
            if (res.savedRoomId && res.savedNickname) {
                this.safeSendMessage({ action: "OUT_JOIN_ROOM", data: { roomId: res.savedRoomId, nickname: res.savedNickname } }, (response) => {
                    if (response && response.success) {
                        this.openRoom(res.savedRoomId, res.savedNickname, response);
                    } else {
                        chrome.storage.local.remove(['savedRoomId']);
                    }
                });
            }
        });
    }

    initVideoObserver() {
        const trackedVideos = new WeakSet();
        const pendingAttach = new WeakMap();

        const isDisziboxPlatform = () => window.location.href.match(/dizibox|vidmoly|upstream|molystream/i);

        const attachHandler = (video) => {
            if (this.activeHandler && this.activeHandler.video === video && this.activeHandler.trackedSrc === video.src) return;

            if (this.activeHandler) this.activeHandler.destroy();
            this.isAdPlaying = false;

            const url = window.location.href;
            if (url.includes("amazon") || url.includes("primevideo")) {
                this.activeHandler = new AmazonHandler(video, this.currentRoomId, this);
            } else if (url.includes("youtube")) {
                this.activeHandler = new YouTubeHandler(video, this.currentRoomId, this);
            } else {
                this.activeHandler = new DiziboxHandler(video, this.currentRoomId, this);
            }
        };

        const tryAttachHandler = (video) => {
            if (this.activeHandler && this.activeHandler.video === video && this.activeHandler.trackedSrc === video.src) return;

            // Dizibox'ta reklam tespiti: kısa süreli videonun bitmesini bekle
            if (isDisziboxPlatform() && !isNaN(video.duration) && video.duration > 0 && video.duration < 60) {
                // Bu bir reklam olabilir — bitince tekrar dene
                if (pendingAttach.has(video)) clearTimeout(pendingAttach.get(video));
                const t = setTimeout(() => {
                    pendingAttach.delete(video);
                    // Timeout dolduğunda duration hâlâ kısaysa reklam devam ediyor, beklemeye devam et
                    if (!isNaN(video.duration) && video.duration < 60) return;
                    attachHandler(video);
                }, (video.duration - video.currentTime + 1) * 1000);
                pendingAttach.set(video, t);
                return;
            }

            // Dizibox değilse veya duration yeterliyse direkt bağla
            if (pendingAttach.has(video)) {
                clearTimeout(pendingAttach.get(video));
                pendingAttach.delete(video);
            }
            attachHandler(video);
        };

        const watchVideo = (video) => {
            if (trackedVideos.has(video)) return;
            trackedVideos.add(video);

            video.addEventListener('loadedmetadata', () => tryAttachHandler(video));
            video.addEventListener('durationchange', () => tryAttachHandler(video));

            if (!isNaN(video.duration) && video.duration > 0 && video.offsetWidth > 50) {
                tryAttachHandler(video);
            }
        };

        const observer = new MutationObserver(() => {
            document.querySelectorAll('video').forEach(v => watchVideo(v));
        });

        document.querySelectorAll('video').forEach(v => watchVideo(v));
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    }

    pulseSync() {
        if (!chrome.runtime?.id || this.isTransitioning) return;
        if (this.activeHandler) {
            chrome.storage.local.get(['savedRoomId'], (res) => {
                if (res.savedRoomId) {
                    this.currentRoomId = res.savedRoomId;
                    this.activeHandler.roomId = res.savedRoomId;
                    const currentData = this.activeHandler.extractMetadata();
                    if (this.pendingCommand && this.pendingCommand.videoId === currentData.videoId) {
                        const cmdToRun = this.pendingCommand;
                        this.pendingCommand = null;
                        this.activeHandler.executeCommand(cmdToRun);
                    }
                    this.activeHandler.updateMetadata();
                }
            });
        }
    }

    executeCommandSafe(cmd) {
        if (!this.activeHandler) return;
        if (cmd.action === 'pause') { this.activeHandler.executeCommand(cmd); return; }
        const currentVideoId = this.activeHandler.extractMetadata().videoId;
        if (cmd.videoId && currentVideoId !== cmd.videoId) {
            this.pendingCommand = cmd;
            return;
        }
        this.activeHandler.executeCommand(cmd);
    }

    updateProgress(currentTime, duration) {
        if (!this.shadow) return;
        const fill = this.shadow.getElementById('cw-progress-fill');
        const timeDisp = this.shadow.getElementById('cw-time-display');
        if (fill && timeDisp) {
            fill.style.width = `${(currentTime / duration) * 100}%`;
            timeDisp.innerText = `${this.formatTime(currentTime)} / ${this.formatTime(duration)}`;
        }
    }

    setTitle(title) {
        if (!this.shadow) return;
        const titleEl = this.shadow.getElementById('cw-video-title');
        if (titleEl && title && titleEl.innerHTML !== title) titleEl.innerHTML = title;
    }

    formatTime(sec) {
        if (isNaN(sec) || !isFinite(sec)) return "00:00";
        const m = Math.floor((sec % 3600) / 60).toString().padStart(2, '0');
        const s = Math.floor(sec % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
    }

    addMessage(senderNick, text, type = "normal") {
        if (!this.shadow || text == null) return;
        const history = this.shadow.getElementById('cw-chat-history');
        if (type === "system") {
            history.innerHTML += `<div class="sys-msg">${text}</div>`;
        } else if (type === "error") {
            history.innerHTML += `<div class="sys-err">${text}</div>`;
        } else {
            const alignmentClass = (senderNick === this.currentUser.nickname) ? 'msg-self' : 'msg-other';
            history.innerHTML += `<div class="cw-message ${alignmentClass}"><span class="cw-nick">${senderNick}</span><div class="cw-bubble">${text}</div></div>`;
        }
        history.scrollTop = history.scrollHeight;
    }

    renderUserList(users) {
        if (!this.shadow) return;
        const listEl = this.shadow.getElementById('cw-user-list');
        if (!listEl) return;
        listEl.innerHTML = '';
        users.forEach(u => {
            const timeFormatted = this.formatTime(u.lastTime);
            listEl.innerHTML += `<div class="user-li"><span>${u.isBuffering ? '⏳' : '🟢'} ${u.nickname}</span><span class="time-badge" data-nick="${u.nickname}">${timeFormatted}</span></div>`;
        });
    }

    openRoom(roomId, nickname, serverRes) {
        const app = this.shadow.getElementById('cw-app');
        app.style.display = 'flex';
        this.currentRoomId = roomId;
        this.currentUser.nickname = nickname;
        if (this.activeHandler) this.activeHandler.roomId = roomId;

        this.shadow.getElementById('cw-room-id').innerText = roomId;
        this.shadow.getElementById('cw-chat-history').innerHTML = '';

        if (serverRes.chatHistory) serverRes.chatHistory.forEach(m => this.addMessage(m.nickname, m.text));
        this.renderUserList(serverRes.activeUsers || []);
        if (serverRes.roomState) this.reconcileRoomVideo(serverRes.roomState);
    }

    reconcileRoomVideo(roomState) {
        if (!roomState || !roomState.videoId) return;
        const myData = this.activeHandler ? this.activeHandler.extractMetadata() : { platform: detectPlatformFromUrl(window.location.href), videoId: null };

        if (myData.platform !== roomState.platform) {
            this.addMessage("Sistem", `Bu oda "${roomState.platform}" platformu için kuruldu.<br><br><a href="${roomState.url}" target="_blank" style="color:#ff9900; text-decoration:underline; font-weight:bold; cursor:pointer;">🎥 Doğru videoya gitmek için tıklayın</a>`, "system");
            return;
        }
        if (myData.videoId !== roomState.videoId) {
            this.navigateToRoomVideo(roomState.platform, roomState.videoId, roomState.url);
        }
    }

    navigateToRoomVideo(platform, videoId, url) {
        const currentUrl = window.location.href;
        if (videoId && !currentUrl.includes(videoId)) {
            if (platform === 'amazon') {
                let hostToUse = window.location.hostname;
                if (!hostToUse.includes("amazon") && !hostToUse.includes("primevideo")) {
                    try { hostToUse = new URL(url).hostname; } catch (e) { hostToUse = "www.primevideo.com"; }
                }
                if (hostToUse.includes("primevideo.com")) window.location.replace(`https://${hostToUse}/detail/${videoId}/?autoplay=1`);
                else window.location.replace(`https://${hostToUse}/gp/video/detail/${videoId}/?autoplay=1`);
            } else {
                window.location.replace(url);
            }
        }
    }

    listenForBackgroundMessages() {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.action === "AMAZON_AD_DETECTED") {
                if (!this.isAdPlaying) {
                    this.isAdPlaying = true;
                    console.log("📺 Co-Watch: Amazon Reklamı tespit edildi!");
                    if (this.currentRoomId) this.safeSendMessage({ action: "OUT_AD_PLAYING", data: { roomId: this.currentRoomId } });
                }
            }
            else if (request.action === "NETWORK_VIDEO_ID_DETECTED" && request.data.platform === "amazon") {
                this.globalNetworkGTI = request.data.videoId;
                this.enterTransitionMode(request.data.videoId);
                if (this.activeHandler) this.activeHandler.updateMetadata();
            }
            else if (request.action === "GET_CURRENT_METADATA") {
                if (this.activeHandler) {
                    sendResponse({ metadata: this.activeHandler.extractMetadata() });
                } else {
                    let videoId = this.globalNetworkGTI || null;
                    const url = window.location.href;
                    let platform = detectPlatformFromUrl(url);

                    if (platform === "amazon") {
                        if (!videoId) {
                            const hydration = document.getElementById('dv-web-page-hydration-data');
                            if (hydration) {
                                const match = hydration.textContent.match(/"playbackID"\s*:\s*"([^"]+)"/i) || hydration.textContent.match(/"gti"\s*:\s*"([^"]+)"/i);
                                if (match) videoId = match[1];
                            }
                        }
                        if (!videoId) {
                            const dpMatch = url.match(/(?:dp|detail|video\/detail)\/([a-zA-Z0-9]+)/i);
                            videoId = dpMatch ? dpMatch[1] : null;
                        }
                    } else if (platform === "youtube") {
                        videoId = new URL(url).searchParams.get('v');
                    }
                    sendResponse({ metadata: { platform, videoId, url, title: document.title } });
                }
            }
            else if (request.action === "FORCE_UI_STATE") {
                if (this.isMainFrame) this.openRoom(request.roomId, request.nickname, request.response);
            }
            else if (request.action === "SHOW_CHAT") {
                if (this.isMainFrame && this.shadow) this.shadow.getElementById('cw-app').style.display = 'flex';
            }
            else if (request.action === "EXECUTE_CMD") {
                this.executeCommandSafe(request.cmd);
            }
            else if (request.action === "NEW_MESSAGE") {
                this.addMessage(request.msg.nickname, request.msg.text);
            }
            else if (request.action === "SYSTEM_MESSAGE") {
                this.addMessage("Sistem", request.msg.text, "system");
            }
            else if (request.action === "SYSTEM_ERROR") {
                this.addMessage("Uyarı", request.msg.message, "error");
            }
            else if (request.action === "USER_LIST_UPDATE") {
                this.renderUserList(request.users);
            }
            else if (request.action === "USER_TIMES_UPDATE") {
                if (!this.isMainFrame || !this.shadow) return;
                request.times.forEach(t => {
                    const badge = this.shadow.querySelector(`.time-badge[data-nick="${t.nickname}"]`);
                    if (badge) badge.innerText = this.formatTime(t.lastTime);
                });
            }
            else if (request.action === "REDIRECT_FORCE") {
                if (this.isMainFrame) {
                    this.navigateToRoomVideo(request.data.platform, request.data.videoId, request.data.url);
                }
            }
            else if (request.action === "LEAVE_ROOM") {
                if (this.isMainFrame && this.shadow) this.shadow.getElementById('cw-app').style.display = 'none';
                this.currentRoomId = null;
                if (this.activeHandler) this.activeHandler.roomId = null;
            }
            else if (request.action === "DO_TOGGLE_THEATER_MODE") {
                if (this.isMainFrame) {
                    if (document.body.classList.contains('cw-theater-mode')) {
                        document.body.classList.remove('cw-theater-mode');
                        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
                        this.addMessage("Sistem", "Sohbetli tam ekrandan çıkıldı.", "system");
                    } else {
                        document.body.classList.add('cw-theater-mode');
                        this.addMessage("Sistem", "Sohbetli tam ekrana geçildi. Çıkmak için ESC'ye veya tekrar Tam Ekran tuşuna basabilirsiniz.", "system");
                        if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
                    }
                }
            }
            else if (request.action === "DO_EXIT_THEATER_MODE") {
                if (this.isMainFrame) {
                    document.body.classList.remove('cw-theater-mode');
                    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
                }
            }
            else if (request.action === "TOP_URL_CHANGED") {
                this.topUrl = request.url;
                if (this.activeHandler && this.activeHandler instanceof DiziboxHandler) {
                    this.activeHandler.updateMetadata();
                }
            }
        });
    }
}

if (!window.coWatchInstance) window.coWatchInstance = new CoWatchCore();