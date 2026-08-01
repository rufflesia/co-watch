// ============================================================================
// CO-WATCH CORE V4.6
// ============================================================================
const PLATFORM_SELECTORS = {
    amazon: { title: '.atvwebplayersdk-title-text', subtitle: '.atvwebplayersdk-subtitle-text', playButton: '[data-testid="dp-atf-play-button"], [data-automation-id="dp-atf-play-button"]' },
    youtube: { title: 'h1.ytd-video-primary-info-renderer, h1.title yt-formatted-string' },
    dizibox: { title: '.entry-title, h1' }
};

function detectPlatformFromUrl(url) {
    if (url.includes("amazon") || url.includes("primevideo")) return "amazon";
    if (url.includes("youtube")) return "youtube";
    if (url.match(/dizibox|vidmoly|upstream|molystream|fullhdfilmizlesene|rapidvid/i)) return "dizibox";
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
        chrome.runtime.sendMessage({ action: "OUT_USER_ACTION", data: { roomId: this.roomId, action, time: this.video.currentTime, isPlaying: !this.video.paused, videoId: videoData.videoId } });
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
            setTimeout(() => { this.ui.syncLock = false; }, 1500);
        }
        if (cmd.action === 'play' && this.video.paused) {
            this.ignoreNext.play = true;
            const p = this.video.play();
            if (p !== undefined) p.catch(() => { this.ignoreNext.play = false; });
        } else if (cmd.action === 'pause' && !this.video.paused) {
            this.ignoreNext.pause = true;
            this.video.pause();
        }
    }

    updateMetadata() {
        if (!this.roomId) return;
        const data = this.extractMetadata();
        this.ui.setTitle(data.title);
        if (!this.video.paused && !this.ui.isTransitioning && !this.ui.syncLock && !this.ui.isAdPlaying) {
            chrome.runtime.sendMessage({ action: "OUT_SYNC_TIME", data: { roomId: this.roomId, time: this.video.currentTime, isPlaying: true, platform: data.platform, videoId: data.videoId, url: data.url } });
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
        return { platform: 'amazon', videoId, url, title: displayTitle };
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
    constructor(videoElement, roomId, uiController) { super(videoElement, roomId, uiController); }
    destroy() { super.destroy(); }
    extractMetadata() {
        let actualUrl = window.coWatchInstance.topUrl || window.location.href;
        let videoId = "dizibox-video";
        try {
            const urlObj = new URL(actualUrl);
            videoId = urlObj.pathname.replace(/\/$/, '') || "generic-video";
        } catch (e) {}
        const titleEl = window === window.top ? document.querySelector(PLATFORM_SELECTORS.dizibox.title) : null;
        let displayTitle = titleEl ? titleEl.innerText : (document.title || "Dizi/Film İzleme");
        return { platform: 'dizibox', videoId, url: actualUrl, title: displayTitle };
    }
}

// YENİ: Bilinmeyen sitelerde çalışacak Evrensel (Generic) Handler
class GenericHandler extends VideoHandler {
    constructor(videoElement, roomId, uiController) {
        super(videoElement, roomId, uiController);
        
        // Videoya tıklandığında oynat/duraklat yapacak olay (event)
        this._onVideoClick = (e) => {
            if (this.video.paused) {
                this.video.play().catch(() => {});
            } else {
                this.video.pause();
            }
        };
        
        this.video.addEventListener('click', this._onVideoClick);
    }

    destroy() {
        super.destroy();
        this.video.removeEventListener('click', this._onVideoClick);
    }

    extractMetadata() {
        let actualUrl = window.location.href;
        let videoId = window.location.pathname || "generic-video";
        
        return { 
            platform: 'generic', 
            videoId: videoId, 
            url: actualUrl, 
            title: document.title || "Bilinmeyen Video" 
        };
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
        this.redirectEnabled = true;
        this.showProgressBar = true;
        this.typingTimeout = null;
        
        // YENİ: WhatsApp Tarzı Gruplama ve Yanıtlama için değişkenler
        this.lastMessageSender = null; 
        this.replyingTo = null;        

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
            body.cw-theater-mode iframe[src*="king"],
            body.cw-theater-mode iframe[src*="rapidvid"] {
                position: fixed !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important;
                z-index: 2147483645 !important; border: none !important; background: #000 !important;
            }
            body.cw-theater-mode.cw-fixed-mode iframe[src*="molystream"],
            body.cw-theater-mode.cw-fixed-mode iframe[src*="vidmoly"],
            body.cw-theater-mode.cw-fixed-mode iframe[src*="upstream"],
            body.cw-theater-mode.cw-fixed-mode iframe[src*="king"],
            body.cw-theater-mode.cw-fixed-mode iframe[src*="rapidvid"] {
                width: calc(100vw - 340px) !important;
            }
            html.cw-fixed-mode { overflow-x: hidden !important; }
            body.cw-fixed-mode * { max-width: none !important; }
            body.cw-fixed-mode {
                width: calc(100vw - 340px) !important;
                margin: 0 !important;
                padding-right: 0 !important;
                overflow-x: hidden !important;
                transition: width 0.3s ease;
            }
        
        html.cw-youtube-fixed-mode, body.cw-youtube-fixed-mode {
                width: calc(100vw - 340px) !important;
                overflow-x: hidden !important;
                margin: 0 !important;
            }
            html.cw-youtube-fixed-mode ytd-app {
                width: calc(100vw - 340px) !important;
            }
            html.cw-youtube-fixed-mode ytd-masthead {
                width: calc(100vw - 340px) !important;
                right: 340px !important; 
            }

        html.cw-amazon-fixed-mode, body.cw-amazon-fixed-mode {
                width: calc(100vw - 340px) !important;
                overflow-x: hidden !important;
                margin: 0 !important;
            }
            html.cw-amazon-fixed-mode .webPlayerContainer,
            html.cw-amazon-fixed-mode .atvwebplayersdk-playercontainer {
                width: calc(100vw - 340px) !important;
            }
            body.cw-amazon-fixed-mode :fullscreen {
                padding-right: 340px !important;
                box-sizing: border-box !important;
            }
        `;
        document.head.appendChild(style);
    }

    handleNativeFullscreen() {
        document.addEventListener('fullscreenchange', () => {
            if (!this.isMainFrame && document.fullscreenElement) {
                document.exitFullscreen().then(() => { this.safeSendMessage({ action: "TOGGLE_THEATER_MODE" }); }).catch(e => console.log(e));
            } else if (this.isMainFrame) {
                const host = document.getElementById('cowatch-root');
                if (!host) return;
                if (document.fullscreenElement) {
                    if (document.fullscreenElement.tagName !== 'IFRAME') document.fullscreenElement.appendChild(host);
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
        if (!this.isTransitioning) console.log(`🛑 Co-Watch: Geçiş Modu AKTİF.`);
        this.isTransitioning = true;
        this.targetTransitionId = targetVideoId;
        if (this.globalNetworkGTI !== targetVideoId) this.globalNetworkGTI = null;
        if (this.transitionTimeout) clearTimeout(this.transitionTimeout);
        this.transitionTimeout = setTimeout(() => {
            if (this.isTransitioning) { this.isTransitioning = false; this.targetTransitionId = null; }
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
        if (data.videoId === this.targetTransitionId && handler.video.currentTime > 0.1 && !handler.video.paused) this.exitTransitionMode();
    }

    safeSendMessage(message, callback) {
        if (!chrome.runtime?.id) return;
        try { chrome.runtime.sendMessage(message, callback); } catch (e) {}
    }

    triggerReflow() {
        window.dispatchEvent(new Event('resize'));
        setTimeout(() => window.dispatchEvent(new Event('resize')), 350); 
    }

    setFixedMode(enabled) {
        const isYouTube = window.location.hostname.includes('youtube.com');
        const isAmazon = window.location.hostname.includes('amazon') || window.location.hostname.includes('primevideo');
        
        if (isYouTube) {
            document.documentElement.classList.toggle('cw-youtube-fixed-mode', enabled);
            document.body.classList.toggle('cw-youtube-fixed-mode', enabled);
        } else if (isAmazon) {
            document.documentElement.classList.toggle('cw-amazon-fixed-mode', enabled);
            document.body.classList.toggle('cw-amazon-fixed-mode', enabled);
        } else {
            document.documentElement.classList.toggle('cw-fixed-mode', enabled);
            document.body.classList.toggle('cw-fixed-mode', enabled);
        }
    }

    injectUI() {
        const cowatchHost = document.createElement('div');
        cowatchHost.id = 'cowatch-root';
        document.body.appendChild(cowatchHost);
        this.shadow = cowatchHost.attachShadow({ mode: 'open' });

        this.shadow.innerHTML = `
        <style>
            :host {
                font-family: 'Segoe UI', system-ui, sans-serif;
                font-size: 14px;
                --bg: rgba(14, 14, 16, 0.92);
                --border: rgba(255,255,255,0.07);
                --text: #e8e8e8;
                --accent: #ff9900;
                --danger: #ff4444;
                --bubble-in: rgba(255,153,0,0.15);
                --bubble-out: rgba(40,40,44,0.9);
                --scrollbar: rgba(255,255,255,0.08);
            }

            * { box-sizing: border-box; }

            #cw-app {
                display: none;
                background: var(--bg);
                backdrop-filter: blur(20px);
                -webkit-backdrop-filter: blur(20px);
                border: 1px solid var(--border);
                color: var(--text);
                flex-direction: column;
                overflow: hidden;
                z-index: 2147483647;
                box-shadow: -4px 0 32px rgba(0,0,0,0.6);
                position: fixed;
            }

            /* COMPACT MODE */
            .mode-compact {
                top: 20px; right: 20px;
                width: 340px; height: 500px;
                border-radius: 16px;
            }
            .mode-compact #cw-header { cursor: grab; }
            .mode-compact #cw-header:active { cursor: grabbing; }

            /* INTERACTIVE MODE */
            .mode-interactive {
                top: 0; right: 0;
                width: 340px; height: 100vh;
                border-radius: 16px 0 0 16px;
                border-right: none;
                transform: translateX(100%);
                opacity: 0;
                transition: transform 0.3s cubic-bezier(0.4,0,0.2,1), opacity 0.3s ease;
                pointer-events: none;
            }
            .mode-interactive.show {
                transform: translateX(0);
                opacity: 1;
                pointer-events: all;
            }
            #cw-edge-trigger {
                position: fixed; top: 0; right: 0;
                width: 18px; height: 100vh;
                z-index: 2147483646;
                display: none;
                cursor: pointer;
            }
            #cw-edge-bar {
                position: absolute;
                right: 0; top: 50%;
                transform: translateY(-50%);
                width: 3px; height: 60px;
                background: rgba(255,153,0,0.3);
                border-radius: 3px 0 0 3px;
                transition: width 0.2s, background 0.2s, height 0.2s;
            }
            #cw-edge-trigger:hover #cw-edge-bar {
                width: 5px;
                background: rgba(255,153,0,0.7);
            }
            #cw-edge-bar.notify {
                animation: cw-bar-pulse 0.45s ease 3;
            }
            @keyframes cw-bar-pulse {
                0%   { width: 3px; height: 60px;  background: rgba(255,153,0,0.3); }
                50%  { width: 8px; height: 110px; background: rgba(255,153,0,1); }
                100% { width: 3px; height: 60px;  background: rgba(255,153,0,0.3); }
            }

            /* FIXED MODE */
            .mode-fixed {
                top: 0; right: 0;
                width: 340px; height: 100vh;
                border-radius: 0;
                border-left: 1px solid var(--border);
            }

            /* HEADER */
            #cw-header {
                display: flex; justify-content: space-between; align-items: center;
                padding: 11px 14px;
                background: rgba(0,0,0,0.5);
                border-bottom: 1px solid var(--border);
                flex-shrink: 0;
            }
            .cw-tabs { display: flex; gap: 12px; }
            .cw-tabs button {
                background: none; border: none; color: #555;
                cursor: pointer; padding: 0 0 4px 0;
                font-weight: bold; font-size: 15px;
                transition: color 0.2s;
            }
            .cw-tabs button.active { color: var(--accent); border-bottom: 2px solid var(--accent); }
            .copy-badge {
                background: rgba(255,153,0,0.08);
                border: 1px dashed rgba(255,153,0,0.5);
                color: var(--accent);
                padding: 3px 8px; border-radius: 6px;
                font-size: 11px; cursor: pointer; font-family: monospace;
                transition: background 0.2s;
            }
            .copy-badge:hover { background: rgba(255,153,0,0.15); }
            .header-controls { display: flex; align-items: center; gap: 6px; }
            .header-controls button {
                background: none; border: none; cursor: pointer;
                font-size: 15px; padding: 4px; color: #666;
                transition: color 0.2s;
            }
            .header-controls button:hover { color: #ccc; }

            /* BODY */
            #cw-body { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
            .cw-view { display: none; flex: 1; flex-direction: column; overflow: hidden; }
            .cw-view.active-view { display: flex; }

            /* CHAT VIEW */
            #view-chat { padding: 10px 0 0 0; }
            #cw-chat-history {
                flex: 1;
                overflow-y: auto;
                display: flex;
                flex-direction: column;
                gap: 8px;
                padding: 4px 14px 8px 14px;
                scrollbar-width: thin;
                scrollbar-color: var(--scrollbar) transparent;
            }
            #cw-chat-history::-webkit-scrollbar { width: 4px; }
            #cw-chat-history::-webkit-scrollbar-track { background: transparent; }
            #cw-chat-history::-webkit-scrollbar-thumb { background: var(--scrollbar); border-radius: 4px; }
            #cw-chat-history::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.15); }

            .cw-message { display: flex; flex-direction: column; max-width: 82%; }
            .cw-nick { font-size: 10px; color: #555; margin-bottom: 3px; }
            .cw-bubble { padding: 8px 12px; word-break: break-word; line-height: 1.45; font-size: 13px; }

            /* Gelen mesaj: renkli (accent) */
            .msg-other { align-self: flex-start; }
            .msg-other .cw-nick { text-align: left; }
            .msg-other .cw-bubble {
                background: var(--bubble-in);
                color: #f0d5a0;
                border-radius: 0 12px 12px 12px;
                border: 1px solid rgba(255,153,0,0.12);
            }

            /* Giden mesaj: gri */
            .msg-self { align-self: flex-end; }
            .msg-self .cw-nick { text-align: right; }
            .msg-self .cw-bubble {
                background: var(--bubble-out);
                color: #bbb;
                border-radius: 12px 12px 0 12px;
                border: 1px solid rgba(255,255,255,0.05);
            }

            .sys-msg { color: rgba(255,153,0,0.7); font-style: italic; font-size: 11px; text-align: center; margin: 4px 0; line-height: 1.5; }
            .sys-err { color: var(--danger); font-size: 11px; text-align: center; }

            /* TYPING INDICATOR */
            #cw-typing {
                min-height: 20px;
                padding: 2px 14px;
                font-size: 11px;
                color: #666;
                display: flex;
                align-items: center;
                gap: 6px;
                flex-shrink: 0;
            }
            .cw-typing-dots { display: flex; gap: 3px; align-items: center; }
            .cw-typing-dots span {
                width: 5px; height: 5px;
                background: #ff9900;
                border-radius: 50%;
                opacity: 0.4;
                animation: cw-dot-bounce 1.2s infinite;
            }
            .cw-typing-dots span:nth-child(2) { animation-delay: 0.2s; }
            .cw-typing-dots span:nth-child(3) { animation-delay: 0.4s; }
            @keyframes cw-dot-bounce {
                0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
                40% { transform: translateY(-4px); opacity: 1; }
            }

        /* GRUPLANMIŞ MESAJLAR (WhatsApp stili) */
        .msg-grouped { margin-top: -6px; }
        .msg-grouped .cw-nick { display: none; }
        .msg-self.msg-grouped .cw-bubble { border-top-right-radius: 4px; }
        .msg-other.msg-grouped .cw-bubble { border-top-left-radius: 4px; }

        /* MESAJ YANITLAMA (Reply) */
        .cw-message { position: relative; }
        .cw-reply-btn { position: absolute; right: -25px; top: 50%; transform: translateY(-50%); cursor: pointer; opacity: 0; transition: opacity 0.2s; font-size: 14px; background: none; border: none; color: #888; }
        .msg-self .cw-reply-btn { right: auto; left: -25px; }
        .cw-message:hover .cw-reply-btn { opacity: 1; }
        .cw-reply-btn:hover { color: var(--accent); }
        .cw-reply-block { font-size: 10px; background: rgba(0,0,0,0.2); border-left: 2px solid var(--accent); padding: 4px 6px; margin-bottom: 4px; border-radius: 4px; color: #aaa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        #cw-reply-preview { display: none; background: rgba(255,153,0,0.1); border-left: 3px solid var(--accent); padding: 6px 10px; font-size: 11px; color: #ccc; flex-shrink: 0; justify-content: space-between; align-items: center; border-top: 1px solid var(--border); }
        #cw-reply-preview.active { display: flex; }
        #cw-reply-close { cursor: pointer; color: #ff4444; font-weight: bold; background: none; border: none; }

        /* KAYBOLAN SİSTEM MESAJLARI */
        .sys-msg.fade-out { animation: fadeOutRemove 0.5s ease forwards; animation-delay: 3.5s; }
        @keyframes fadeOutRemove {
            0% { opacity: 1; max-height: 50px; margin: 4px 0; }
            100% { opacity: 0; max-height: 0; margin: 0; padding: 0; overflow: hidden; }
        }

            /* INPUT AREA */
            #cw-input-area {
                display: flex; gap: 6px;
                padding: 8px 12px 10px 12px;
                border-top: 1px solid var(--border);
                flex-shrink: 0;
                background: rgba(0,0,0,0.2);
            }
            #cw-chat-input {
                flex: 1;
                background: rgba(255,255,255,0.04);
                border: 1px solid rgba(255,255,255,0.08);
                color: white; padding: 9px 12px;
                border-radius: 10px; outline: none;
                font-size: 13px;
                transition: border-color 0.2s;
            }
            #cw-chat-input:focus { border-color: rgba(255,153,0,0.4); }
            #btn-emoji {
                background: rgba(255,255,255,0.05);
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 10px; padding: 0 10px;
                cursor: pointer; font-size: 16px;
                color: #888; transition: all 0.2s;
                flex-shrink: 0;
            }
            #btn-emoji:hover { background: rgba(255,153,0,0.1); color: var(--accent); }
            #btn-send {
                background: var(--accent); color: #000;
                font-weight: bold; border: none;
                border-radius: 10px; padding: 0 14px;
                cursor: pointer; font-size: 16px;
                flex-shrink: 0;
                transition: background 0.2s;
            }
            #btn-send:hover { background: #e68a00; }

            /* EMOJI PICKER */
            #cw-emoji-picker {
                display: none;
                position: absolute;
                bottom: 60px; right: 12px;
                background: rgba(20,20,22,0.97);
                border: 1px solid var(--border);
                border-radius: 12px;
                padding: 10px;
                z-index: 10;
                width: 260px;
                flex-wrap: wrap;
                gap: 4px;
                backdrop-filter: blur(12px);
            }
            #cw-emoji-picker.open { display: flex; }
            #cw-emoji-picker span {
                font-size: 20px; cursor: pointer;
                padding: 4px; border-radius: 6px;
                transition: background 0.15s;
                line-height: 1;
            }
            #cw-emoji-picker span:hover { background: rgba(255,153,0,0.15); }

            /* USERS VIEW */
            #view-users { padding: 12px; overflow-y: auto; }
            .user-li {
                display: flex; justify-content: space-between; align-items: center;
                padding: 10px 12px;
                background: rgba(255,255,255,0.02);
                border: 1px solid var(--border);
                border-radius: 10px; margin-bottom: 8px;
            }
            .time-badge {
                background: rgba(255,153,0,0.12);
                color: var(--accent);
                padding: 3px 8px; border-radius: 10px; font-size: 11px;
            }

            /* SETTINGS VIEW */
            #view-settings {
                padding: 14px;
                overflow-y: auto;
                scrollbar-width: thin;
                scrollbar-color: var(--scrollbar) transparent;
            }
            .settings-section { margin-bottom: 20px; }
            .settings-label {
                font-size: 10px; color: #555;
                text-transform: uppercase; letter-spacing: 1px;
                margin-bottom: 8px;
            }
            .mod-btn-group { display: flex; gap: 5px; }
            .mod-btn {
                flex: 1; background: rgba(255,255,255,0.03);
                border: 1px solid rgba(255,255,255,0.08);
                color: #888; padding: 8px 4px;
                border-radius: 8px; cursor: pointer; font-size: 11px;
                transition: all 0.2s;
            }
            .mod-btn:hover { border-color: rgba(255,153,0,0.3); color: #ccc; }
            .mod-btn.active {
                background: rgba(255,153,0,0.12);
                border-color: rgba(255,153,0,0.4);
                color: var(--accent); font-weight: bold;
            }
            .cw-switch-row {
                display: flex; justify-content: space-between; align-items: center;
                padding: 10px 0;
                border-bottom: 1px solid rgba(255,255,255,0.04);
            }
            .cw-switch-row:last-child { border-bottom: none; }
            .cw-switch-label { font-size: 13px; color: #bbb; }
            .cw-switch-sub { font-size: 10px; color: #555; margin-top: 2px; }
            .cw-switch {
                position: relative; width: 38px; height: 20px;
                flex-shrink: 0;
            }
            .cw-switch input { opacity: 0; width: 0; height: 0; }
            .cw-switch-slider {
                position: absolute; cursor: pointer;
                top: 0; left: 0; right: 0; bottom: 0;
                background: #333; border-radius: 20px;
                transition: 0.25s;
            }
            .cw-switch-slider::before {
                content: ''; position: absolute;
                height: 14px; width: 14px;
                left: 3px; bottom: 3px;
                background: #666; border-radius: 50%;
                transition: 0.25s;
            }
            .cw-switch input:checked + .cw-switch-slider { background: rgba(255,153,0,0.3); }
            .cw-switch input:checked + .cw-switch-slider::before { transform: translateX(18px); background: var(--accent); }

            /* PROGRESS BAR */
            #cw-manual-bar-container {
                background: rgba(0,0,0,0.7);
                padding: 10px 14px 12px 14px;
                border-top: 1px solid var(--border);
                flex-shrink: 0;
            }
            #cw-video-title {
                font-size: 11px; color: #666;
                white-space: nowrap; overflow: hidden;
                text-overflow: ellipsis; margin-bottom: 8px;
            }
            .controls-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
            .ctrl-btn {
                background: rgba(255,255,255,0.06);
                color: #aaa; border: none;
                border-radius: 6px; padding: 5px 8px;
                cursor: pointer; font-size: 12px;
                white-space: nowrap;
                transition: all 0.2s;
            }
            .ctrl-btn:hover { background: rgba(255,153,0,0.15); color: var(--accent); }
            #cw-progress-bg {
                flex: 1; height: 6px;
                background: rgba(255,255,255,0.1);
                border-radius: 4px; cursor: pointer;
                position: relative;
            }
            #cw-progress-fill {
                height: 100%; background: var(--accent);
                width: 0%; border-radius: 4px;
                transition: width 0.5s linear;
            }
            #cw-time-display { font-size: 10px; color: #555; text-align: center; margin-top: 5px; }
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
                    <button id="btn-leave-ui" title="Odadan çık">✕</button>
                </div>
            </div>

            <div id="cw-body">
                <div id="view-chat" class="cw-view active-view">
                    <div id="cw-chat-history"></div>
                    
                    <div id="cw-typing" style="opacity: 0; transition: opacity 0.3s; pointer-events: none;">
                        <div class="cw-typing-dots"><span></span><span></span><span></span></div>
                        <span id="cw-typing-text"></span>
                    </div>

                    <div id="cw-reply-preview">
                        <div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                            <b style="color:var(--accent)" id="cw-reply-name"></b>: <span id="cw-reply-text"></span>
                        </div>
                        <button id="cw-reply-close">✕</button>
                    </div>

                    <div style="position:relative;">
                        <div id="cw-emoji-picker">
                            ${['😀','😂','😍','🥹','😎','🤔','😴','😭','🤣','❤️','🔥','👏','🎉','💀','🙏','👀','🤯','😤','🥶','🍿','⏸️','▶️','🎬','💬','🎭','✨','💯','🤌'].map(e => `<span>${e}</span>`).join('')}
                        </div>
                    </div>
                    <div id="cw-input-area">
                        <input type="text" id="cw-chat-input" placeholder="Mesaj gönder...">
                        <button id="btn-emoji" title="Emoji">😊</button>
                        <button id="btn-send">➤</button>
                    </div>
                </div>

                <div id="view-users" class="cw-view">
                    <div id="cw-user-list"></div>
                </div>

                <div id="view-settings" class="cw-view">
                    <div class="settings-section">
                        <div class="settings-label">Görünüm Modu</div>
                        <div class="mod-btn-group">
                            <button class="mod-btn active" data-mode="mode-compact">📱 Kompakt</button>
                            <button class="mod-btn" data-mode="mode-interactive">👉 İnteraktif</button>
                            <button class="mod-btn" data-mode="mode-fixed">📌 Sabit</button>
                        </div>
                    </div>
                    <div class="settings-section">
                        <div class="settings-label">Seçenekler</div>
                        <div class="cw-switch-row">
                            <div>
                                <div class="cw-switch-label">Video İlerleme Çubuğu</div>
                                <div class="cw-switch-sub">Alttaki zaman çubuğunu göster</div>
                            </div>
                            <label class="cw-switch">
                                <input type="checkbox" id="sw-progress" checked>
                                <span class="cw-switch-slider"></span>
                            </label>
                        </div>
                        <div class="cw-switch-row" id="row-redirect" style="display:none;">
                            <div>
                                <div class="cw-switch-label">URL Yönlendirme</div>
                                <div class="cw-switch-sub">Odanın videosuna otomatik git (Admin)</div>
                            </div>
                            <label class="cw-switch">
                                <input type="checkbox" id="sw-redirect" checked>
                                <span class="cw-switch-slider"></span>
                            </label>
                        </div>
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
                    <div id="cw-time-display">00:00 / 00:00</div>
                </div>
            </div>
        </div>
        <div id="cw-edge-trigger"><div id="cw-edge-bar"></div></div>
        `;
        this.bindUIEvents();
        this.checkAutoJoin();
    }

    bindUIEvents() {
        const app = this.shadow.getElementById('cw-app');
        const header = this.shadow.getElementById('cw-header');
        const chatInput = this.shadow.getElementById('cw-chat-input');
        const edgeTrigger = this.shadow.getElementById('cw-edge-trigger');
        const emojiPicker = this.shadow.getElementById('cw-emoji-picker');

        const blockSocks = (e) => e.stopPropagation();
        chatInput.addEventListener('keydown', blockSocks);
        chatInput.addEventListener('keypress', blockSocks);
        chatInput.addEventListener('keyup', blockSocks);

        chatInput.addEventListener('input', () => {
            if (!this.currentRoomId) return;
            this.safeSendMessage({ action: "OUT_TYPING", data: { roomId: this.currentRoomId } });
        });

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

                app.classList.remove('show');
                this.setFixedMode(false);
                edgeTrigger.style.display = 'none';
                app.style.left = '';
                app.style.top = '';

                app.className = newMode;

                if (newMode === 'mode-interactive') {
                    edgeTrigger.style.display = 'block';
                } else if (newMode === 'mode-fixed') {
                    this.setFixedMode(true);
                }

                this.triggerReflow();
            });
        });

        edgeTrigger.addEventListener('mouseenter', () => {
            if (app.classList.contains('mode-interactive')) app.classList.add('show');
        });
        app.addEventListener('mouseleave', () => {
            if (app.classList.contains('mode-interactive')) app.classList.remove('show');
        });

        this.shadow.getElementById('btn-leave-ui').onclick = () => {
            if (confirm("Odadan tamamen ayrılmak istediğinize emin misiniz?")) {
                chrome.storage.local.remove(['savedRoomId']);
                app.style.display = 'none';
                this.setFixedMode(false);
                this.triggerReflow();
                if (this.currentRoomId) this.safeSendMessage({ action: "OUT_LEAVE_ROOM", data: { roomId: this.currentRoomId } });
                this.currentRoomId = null;
                if (this.activeHandler) this.activeHandler.roomId = null;
            }
        };

        // YENİ: Mesaj Yanıtlama Butonlarına Tıklama (Event Delegation)
        this.shadow.getElementById('cw-chat-history').addEventListener('click', (e) => {
            if (e.target.classList.contains('cw-reply-btn')) {
                const msgNode = e.target.closest('.cw-message');
                const nick = msgNode.getAttribute('data-nick');
                const text = msgNode.getAttribute('data-text');
                
                this.replyingTo = { nickname: nick, text: text };
                this.shadow.getElementById('cw-reply-name').innerText = nick;
                this.shadow.getElementById('cw-reply-text').innerText = text;
                this.shadow.getElementById('cw-reply-preview').classList.add('active');
                chatInput.focus();
            }
        });

        // YENİ: Yanıtı İptal Etme
        this.shadow.getElementById('cw-reply-close').onclick = () => {
            this.replyingTo = null;
            this.shadow.getElementById('cw-reply-preview').classList.remove('active');
        };

        const sendMsg = () => {
            const text = chatInput.value.trim();
            if (text && this.currentRoomId) {
                this.safeSendMessage({ action: "OUT_SEND_MESSAGE", data: { roomId: this.currentRoomId, message: text, replyTo: this.replyingTo } });
                chatInput.value = '';
                emojiPicker.classList.remove('open');
                
                // Mesaj gittikten sonra yanıt önizlemesini temizle
                this.replyingTo = null;
                this.shadow.getElementById('cw-reply-preview').classList.remove('active');
            }
        };
        this.shadow.getElementById('btn-send').onclick = sendMsg;
        chatInput.onkeypress = (e) => { if (e.key === 'Enter') { e.stopPropagation(); sendMsg(); } };

        this.shadow.getElementById('btn-emoji').addEventListener('click', (e) => {
            e.stopPropagation();
            emojiPicker.classList.toggle('open');
        });
        emojiPicker.addEventListener('click', (e) => {
            if (e.target.tagName === 'SPAN') {
                chatInput.value += e.target.textContent;
                chatInput.focus();
                emojiPicker.classList.remove('open');
            }
        });
        this.shadow.addEventListener('click', (e) => {
            if (!emojiPicker.contains(e.target) && e.target.id !== 'btn-emoji') {
                emojiPicker.classList.remove('open');
            }
        });

        this.shadow.getElementById('sw-progress').addEventListener('change', (e) => {
            this.showProgressBar = e.target.checked;
            this.shadow.getElementById('cw-manual-bar-container').style.display = e.target.checked ? 'block' : 'none';
        });

        this.shadow.getElementById('sw-redirect').addEventListener('change', (e) => {
            this.redirectEnabled = e.target.checked;
        });

        this.shadow.getElementById('btn-playpause').onclick = () => {
            if (this.activeHandler && this.activeHandler.video)
                this.activeHandler.video.paused ? this.activeHandler.video.play() : this.activeHandler.video.pause();
        };
        this.shadow.getElementById('btn-rewind').onclick = () => { if (this.activeHandler) this.activeHandler.video.currentTime -= 10; };
        this.shadow.getElementById('btn-forward').onclick = () => { if (this.activeHandler) this.activeHandler.video.currentTime += 10; };
    }

    checkAutoJoin() {
        chrome.storage.local.get(['savedRoomId', 'savedNickname'], (res) => {
            if (res.savedRoomId && res.savedNickname) {
                this.safeSendMessage({ action: "OUT_JOIN_ROOM", data: { roomId: res.savedRoomId, nickname: res.savedNickname } }, (response) => {
                    if (response && response.success) {
                        this.openRoom(res.savedRoomId, res.savedNickname, response, /* isReconnect */ true);
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

        const isDisziboxPlatform = () => window.location.href.match(/dizibox|vidmoly|upstream|molystream|fullhdfilmizlesene|rapidvid/i);

        const attachHandler = (video) => {
            if (this.activeHandler && this.activeHandler.video === video && this.activeHandler.trackedSrc === video.src) return;
            if (this.activeHandler) this.activeHandler.destroy();
            this.isAdPlaying = false;

            const url = window.location.href;
            if (url.includes("amazon") || url.includes("primevideo")) {
                this.activeHandler = new AmazonHandler(video, this.currentRoomId, this);
            } else if (url.includes("youtube")) {
                this.activeHandler = new YouTubeHandler(video, this.currentRoomId, this);
            } else if (url.match(/dizibox|vidmoly|upstream|molystream|fullhdfilmizlesene|rapidvid/i)) {
                this.activeHandler = new DiziboxHandler(video, this.currentRoomId, this);
            } else {
                // YENİ: Hiçbirine uymuyorsa Evrensel (Generic) Handler'ı başlat
                this.activeHandler = new GenericHandler(video, this.currentRoomId, this);
            }
        };

        const tryAttachHandler = (video) => {
            if (this.activeHandler && this.activeHandler.video === video && this.activeHandler.trackedSrc === video.src) return;

            if (isDisziboxPlatform() && !isNaN(video.duration) && video.duration > 0 && video.duration < 60) {
                if (pendingAttach.has(video)) clearTimeout(pendingAttach.get(video));
                const t = setTimeout(() => {
                    pendingAttach.delete(video);
                    if (!isNaN(video.duration) && video.duration < 60) return;
                    attachHandler(video);
                }, (video.duration - video.currentTime + 1) * 1000);
                pendingAttach.set(video, t);
                return;
            }

            if (pendingAttach.has(video)) { clearTimeout(pendingAttach.get(video)); pendingAttach.delete(video); }
            attachHandler(video);
        };

        const watchVideo = (video) => {
            if (trackedVideos.has(video)) return;
            trackedVideos.add(video);
            video.addEventListener('loadedmetadata', () => tryAttachHandler(video));
            video.addEventListener('durationchange', () => tryAttachHandler(video));
            if (!isNaN(video.duration) && video.duration > 0 && video.offsetWidth > 50) tryAttachHandler(video);
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
        if (cmd.videoId && currentVideoId !== cmd.videoId) { this.pendingCommand = cmd; return; }
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

    // YENİ: Gruplama ve Yanıtlama (Reply) mekanizması
    addMessage(senderNick, text, type = "normal", replyTo = null, autoHide = false) {
        if (!this.shadow || text == null) return;
        const history = this.shadow.getElementById('cw-chat-history');
        
        if (type === "system") {
            const autoHideClass = autoHide ? 'fade-out' : '';
            history.insertAdjacentHTML('beforeend', `<div class="sys-msg ${autoHideClass}">${text}</div>`);
            this.lastMessageSender = null; // Sistem mesajı gruplamayı kırar
        } else if (type === "error") {
            history.insertAdjacentHTML('beforeend', `<div class="sys-err">${text}</div>`);
            this.lastMessageSender = null;
        } else {
            const isSelf = (senderNick === this.currentUser.nickname);
            const isGrouped = (this.lastMessageSender === senderNick) && !replyTo;
            
            const cls = (isSelf ? 'msg-self' : 'msg-other') + (isGrouped ? ' msg-grouped' : '');
            
            let replyHtml = '';
            if (replyTo) {
                replyHtml = `<div class="cw-reply-block"><b>${replyTo.nickname}</b>: ${replyTo.text}</div>`;
            }

            const safeText = text.replace(/"/g, '&quot;');
            history.insertAdjacentHTML('beforeend', `
                <div class="cw-message ${cls}" data-nick="${senderNick}" data-text="${safeText}">
                    <button class="cw-reply-btn" title="Yanıtla">${isSelf ? '↪' : '↩'}</button>
                    <span class="cw-nick">${senderNick}</span>
                    <div class="cw-bubble">${replyHtml}${text}</div>
                </div>
            `);
            this.lastMessageSender = senderNick;
        }
        history.scrollTop = history.scrollHeight;
    }

    showTyping(nickname) {
        if (!this.shadow) return;
        const typingEl = this.shadow.getElementById('cw-typing');
        const typingText = this.shadow.getElementById('cw-typing-text');
        
        typingText.innerText = `${nickname} yazıyor...`;
        typingEl.style.opacity = '1';

        if (this._typingClearTimeout) clearTimeout(this._typingClearTimeout);
        this._typingClearTimeout = setTimeout(() => {
            if (typingEl) typingEl.style.opacity = '0';
        }, 3000);
    }

    renderUserList(users) {
        if (!this.shadow) return;
        const listEl = this.shadow.getElementById('cw-user-list');
        if (!listEl) return;
        listEl.innerHTML = '';
        users.forEach(u => {
            listEl.innerHTML += `<div class="user-li"><span>${u.isBuffering ? '⏳' : '🟢'} ${u.nickname}</span><span class="time-badge" data-nick="${u.nickname}">${this.formatTime(u.lastTime)}</span></div>`;
        });
    }

    openRoom(roomId, nickname, serverRes, isReconnect = false) {
        const app = this.shadow.getElementById('cw-app');
        app.style.display = 'flex';
        this.currentRoomId = roomId;
        this.currentUser.nickname = nickname;
        if (this.activeHandler) this.activeHandler.roomId = roomId;

        this.shadow.getElementById('cw-room-id').innerText = roomId;
        
        this.lastMessageSender = null; // Her oda değişiminde gruplamayı sıfırla
        this.shadow.getElementById('cw-chat-history').innerHTML = '';

        if (serverRes.role === 'admin' || serverRes.isAdmin) {
            this.shadow.getElementById('row-redirect').style.display = 'flex';
        }

        if (serverRes.chatHistory) serverRes.chatHistory.forEach(m => this.addMessage(m.nickname, m.text, "normal", m.replyTo));
        this.renderUserList(serverRes.activeUsers || []);
        if (!isReconnect && serverRes.roomState) this.reconcileRoomVideo(serverRes.roomState);
    }

    reconcileRoomVideo(roomState) {
        if (!roomState || !roomState.videoId) return;
        const myData = this.activeHandler ? this.activeHandler.extractMetadata() : { platform: detectPlatformFromUrl(window.location.href), videoId: null };
        if (myData.platform !== roomState.platform) {
            this.addMessage("Sistem", `Bu oda "${roomState.platform}" platformu için kuruldu.<br><br><a href="${roomState.url}" target="_blank" style="color:#ff9900; text-decoration:underline; font-weight:bold; cursor:pointer;">🎥 Doğru videoya gitmek için tıklayın</a>`, "system");
            return;
        }
        if (myData.videoId !== roomState.videoId) this.navigateToRoomVideo(roomState.platform, roomState.videoId, roomState.url);
    }

    navigateToRoomVideo(platform, videoId, url) {
        if (!this.redirectEnabled) return;
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
                this.addMessage(request.msg.nickname, request.msg.text, "normal", request.msg.replyTo);
            }
            else if (request.action === "SYSTEM_MESSAGE") {
                this.addMessage("Sistem", request.msg.text, "system", null, request.msg.autoHide);
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
            else if (request.action === "TYPING_INDICATOR") {
                if (this.isMainFrame && request.nickname !== this.currentUser.nickname) {
                    this.showTyping(request.nickname);
                }
            }
            else if (request.action === "REDIRECT_FORCE") {
                if (this.isMainFrame && this.redirectEnabled) {
                    this.navigateToRoomVideo(request.data.platform, request.data.videoId, request.data.url);
                }
            }
            else if (request.action === "LEAVE_ROOM") {
                if (this.isMainFrame && this.shadow) this.shadow.getElementById('cw-app').style.display = 'none';
                this.setFixedMode(false);
                this.triggerReflow();
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
                        this.addMessage("Sistem", "Sohbetli tam ekrana geçildi. Çıkmak için ESC'ye basabilirsiniz.", "system");
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
