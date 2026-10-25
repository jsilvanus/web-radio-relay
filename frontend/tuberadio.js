/*!
 * tuberadio.js — embeddable audio-only web radio player
 * Version: 1.0.0
 *
 * Usage (declarative — auto-initialises on DOMContentLoaded):
 *   <div data-tuberadio
 *        data-stream-url="/hls/stream.m3u8"
 *        data-status-url="/api/status"
 *        data-archive-url="/api/archive"
 *        data-title="My Radio">
 *   </div>
 *   <script src="tuberadio.js"></script>
 *
 * Usage (programmatic):
 *   const player = new TubeRadio({
 *     container: document.getElementById('player'),
 *     streamUrl: '/api/hls/delayed.m3u8',
 *     statusUrl: '/api/status',
 *     archiveUrl: '/api/archive',
 *     title: 'My Radio',
 *   });
 *
 * HLS.js is loaded from the CDN only if the browser does not support
 * native HLS (i.e. all non-Safari browsers).  No other dependencies.
 */
(function (window, document) {
  'use strict';

  var HLS_JS_CDN = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js';
  var STYLE_ID = 'tuberadio-styles';

  // ---------------------------------------------------------------------------
  // Default options
  // ---------------------------------------------------------------------------
  var DEFAULTS = {
    streamUrl:  '/api/hls/delayed.m3u8',
    statusUrl:  '/api/status',
    archiveUrl: '/api/archive',
    statsUrl:   '/api/stats/event',
    title:      'Tuberadio',
    /** How often to poll the status endpoint (ms) */
    pollInterval: 10000,
  };

  // ---------------------------------------------------------------------------
  // Styles — injected once into <head>
  // ---------------------------------------------------------------------------
  var CSS = [
    '.tr{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
    'background:#1a1a2e;color:#fff;border-radius:14px;padding:22px 24px;',
    'max-width:420px;box-sizing:border-box;user-select:none;',
    'box-shadow:0 8px 32px rgba(0,0,0,.45);}',

    '.tr *{box-sizing:border-box;margin:0;padding:0;}',

    '.tr-header{display:flex;align-items:center;gap:12px;margin-bottom:18px;}',
    '.tr-dot{width:12px;height:12px;border-radius:50%;background:#e94560;flex-shrink:0;',
    'box-shadow:0 0 0 3px rgba(233,69,96,.25);transition:background .4s,box-shadow .4s;}',
    '.tr-dot.live{background:#22c55e;',
    'box-shadow:0 0 0 4px rgba(34,197,94,.25);',
    'animation:tr-pulse 1.8s ease-in-out infinite;}',
    '@keyframes tr-pulse{0%,100%{box-shadow:0 0 0 4px rgba(34,197,94,.25)}',
    '50%{box-shadow:0 0 0 8px rgba(34,197,94,.05)}}',
    '.tr-title{font-size:1.1rem;font-weight:700;letter-spacing:.02em;}',
    '.tr-badge{margin-left:auto;font-size:.68rem;font-weight:600;letter-spacing:.06em;',
    'padding:3px 9px;border-radius:20px;background:#333;color:#aaa;text-transform:uppercase;}',
    '.tr-badge.live{background:rgba(34,197,94,.18);color:#22c55e;}',

    '.tr-controls{display:flex;align-items:center;gap:14px;margin-bottom:16px;}',
    '.tr-btn{background:none;border:none;cursor:pointer;padding:0;',
    'color:#fff;display:flex;align-items:center;justify-content:center;',
    'border-radius:50%;transition:opacity .2s;}',
    '.tr-btn:hover{opacity:.75;}',
    '.tr-btn:disabled{opacity:.3;cursor:default;}',
    '.tr-play-btn{width:48px;height:48px;background:#e94560;border-radius:50%;',
    'flex-shrink:0;transition:background .2s;}',
    '.tr-play-btn:hover:not(:disabled){background:#c73652;}',

    '.tr-volume{display:flex;align-items:center;gap:8px;margin-left:auto;}',
    '.tr-vol-icon{color:#aaa;flex-shrink:0;}',
    '.tr-vol-slider{-webkit-appearance:none;appearance:none;',
    'width:80px;height:4px;border-radius:2px;',
    'background:linear-gradient(to right,#e94560 var(--val,70%),#444 var(--val,70%));',
    'outline:none;cursor:pointer;}',
    '.tr-vol-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;',
    'width:14px;height:14px;border-radius:50%;background:#fff;cursor:pointer;}',
    '.tr-vol-slider::-moz-range-thumb{width:14px;height:14px;border-radius:50%;',
    'background:#fff;border:none;cursor:pointer;}',

    '.tr-status{font-size:.8rem;color:#888;min-height:1.2em;margin-bottom:14px;}',
    '.tr-status.error{color:#e94560;}',

    '.tr-archive{border-top:1px solid #2a2a3e;padding-top:14px;}',
    '.tr-archive-title{font-size:.78rem;font-weight:600;color:#aaa;',
    'letter-spacing:.06em;text-transform:uppercase;margin-bottom:10px;}',
    '.tr-archive-list{list-style:none;max-height:160px;overflow-y:auto;}',
    '.tr-archive-list::-webkit-scrollbar{width:4px;}',
    '.tr-archive-list::-webkit-scrollbar-track{background:transparent;}',
    '.tr-archive-list::-webkit-scrollbar-thumb{background:#333;border-radius:2px;}',
    '.tr-archive-item{display:flex;align-items:center;gap:10px;',
    'padding:7px 4px;border-bottom:1px solid #22223a;font-size:.82rem;color:#ccc;}',
    '.tr-archive-item:last-child{border-bottom:none;}',
    '.tr-archive-date{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.tr-archive-dl{color:#e94560;text-decoration:none;font-size:.75rem;',
    'font-weight:600;flex-shrink:0;}',
    '.tr-archive-dl:hover{text-decoration:underline;}',
    '.tr-archive-empty{color:#555;font-size:.82rem;padding:6px 4px;}',

    '.tr-info{position:relative;display:flex;align-items:center;margin-left:8px;flex-shrink:0;}',
    '.tr-info-btn{background:none;border:none;padding:0;cursor:pointer;',
    'color:#555;display:flex;align-items:center;transition:color .2s;}',
    '.tr-info-btn:hover{color:#aaa;}',
    '.tr-tooltip{position:absolute;top:calc(100% + 8px);right:0;width:230px;',
    'background:#2a2a3e;color:#ccc;font-size:.74rem;line-height:1.5;',
    'padding:10px 12px;border-radius:8px;border:1px solid #3a3a54;',
    'box-shadow:0 4px 16px rgba(0,0,0,.4);',
    'opacity:0;pointer-events:none;transition:opacity .15s;z-index:10;}',
    '.tr-tooltip::before{content:"";position:absolute;bottom:100%;right:8px;',
    'border:5px solid transparent;border-bottom-color:#3a3a54;}',
    '.tr-info:hover .tr-tooltip,.tr-info-btn:focus+.tr-tooltip{opacity:1;pointer-events:auto;}',
  ].join('');

  // ---------------------------------------------------------------------------
  // SVG icons (inline, no external assets)
  // ---------------------------------------------------------------------------
  function iconInfo() {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">' +
      '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z' +
      'M13 17h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>';
  }

  function iconPlay() {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">' +
      '<path d="M8 5v14l11-7z"/></svg>';
  }
  function iconPause() {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">' +
      '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
  }
  function iconVolume(level) {
    // level: 'high' | 'low' | 'mute'
    if (level === 'mute') {
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">' +
        '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>' +
        '</svg>';
    }
    if (level === 'low') {
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">' +
        '<path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/>' +
        '</svg>';
    }
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">' +
      '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>' +
      '</svg>';
  }

  // ---------------------------------------------------------------------------
  // Utility helpers
  // ---------------------------------------------------------------------------
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function merge(target, source) {
    var result = {};
    for (var k in target) if (Object.prototype.hasOwnProperty.call(target, k)) result[k] = target[k];
    for (var k in source) if (Object.prototype.hasOwnProperty.call(source, k)) result[k] = source[k];
    return result;
  }

  function formatDate(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      return d.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch (e) { return iso; }
  }

  function fetchJSON(url, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'json';
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) cb(null, xhr.response);
      else cb(new Error('HTTP ' + xhr.status));
    };
    xhr.onerror = function () { cb(new Error('Network error')); };
    xhr.send();
  }

  // ---------------------------------------------------------------------------
  // TubeRadio constructor
  // ---------------------------------------------------------------------------
  function TubeRadio(options) {
    this.opts = merge(DEFAULTS, options || {});
    this.hls = null;
    this._audio = null;
    this._live = false;
    this._playing = false;
    this._pollTimer = null;
    this._volume = 0.7;

    injectStyles();
    this._build();
    this._poll();
  }

  // ---------------------------------------------------------------------------
  // Build DOM
  // ---------------------------------------------------------------------------
  TubeRadio.prototype._build = function () {
    var self = this;
    var root = this.opts.container;
    if (!root) { console.warn('TubeRadio: no container element'); return; }

    root.innerHTML = '';
    root.className = (root.className ? root.className + ' ' : '') + 'tr';

    // --- Header ---
    var header = document.createElement('div');
    header.className = 'tr-header';

    this._dot = document.createElement('div');
    this._dot.className = 'tr-dot';

    var titleEl = document.createElement('div');
    titleEl.className = 'tr-title';
    titleEl.textContent = this.opts.title;

    this._badge = document.createElement('div');
    this._badge.className = 'tr-badge';
    this._badge.textContent = 'poissa';

    var infoWrap = document.createElement('div');
    infoWrap.className = 'tr-info';

    var infoBtn = document.createElement('button');
    infoBtn.className = 'tr-info-btn';
    infoBtn.setAttribute('aria-label', 'Tietoa tietojenkeruusta');
    infoBtn.innerHTML = iconInfo();

    var tooltip = document.createElement('div');
    tooltip.className = 'tr-tooltip';
    tooltip.textContent = 'Keräämme nimettömiä käyttötietoja: kuuntelunapin painallukset, ' +
      'arkistolatauksien lukumäärä sekä lähetysajankohdat ja -kestot. ' +
      'Emme tallenna henkilötietoja.';

    infoWrap.appendChild(infoBtn);
    infoWrap.appendChild(tooltip);

    header.appendChild(this._dot);
    header.appendChild(titleEl);
    header.appendChild(this._badge);
    header.appendChild(infoWrap);
    root.appendChild(header);

    // --- Controls row ---
    var controls = document.createElement('div');
    controls.className = 'tr-controls';

    // Play / pause button
    this._playBtn = document.createElement('button');
    this._playBtn.className = 'tr-btn tr-play-btn';
    this._playBtn.innerHTML = iconPlay();
    this._playBtn.setAttribute('aria-label', 'Toista');
    this._playBtn.disabled = true;
    this._playBtn.addEventListener('click', function () { self._togglePlay(); });
    controls.appendChild(this._playBtn);

    // Volume section
    var volWrap = document.createElement('div');
    volWrap.className = 'tr-volume';

    this._volIcon = document.createElement('span');
    this._volIcon.className = 'tr-vol-icon';
    this._volIcon.innerHTML = iconVolume('high');
    this._volIcon.style.cursor = 'pointer';
    this._volIcon.addEventListener('click', function () { self._toggleMute(); });
    volWrap.appendChild(this._volIcon);

    this._volSlider = document.createElement('input');
    this._volSlider.type = 'range';
    this._volSlider.className = 'tr-vol-slider';
    this._volSlider.min = '0';
    this._volSlider.max = '1';
    this._volSlider.step = '0.01';
    this._volSlider.value = String(this._volume);
    this._volSlider.style.setProperty('--val', Math.round(this._volume * 100) + '%');
    this._volSlider.addEventListener('input', function () {
      self._volume = parseFloat(self._volSlider.value);
      self._applyVolume();
    });
    volWrap.appendChild(this._volSlider);
    controls.appendChild(volWrap);

    root.appendChild(controls);

    // --- Status line ---
    this._statusEl = document.createElement('div');
    this._statusEl.className = 'tr-status';
    this._statusEl.textContent = 'Tarkistetaan lähetystä…';
    root.appendChild(this._statusEl);

    // --- Archive section ---
    var archiveWrap = document.createElement('div');
    archiveWrap.className = 'tr-archive';

    var archiveTitle = document.createElement('div');
    archiveTitle.className = 'tr-archive-title';
    archiveTitle.textContent = 'Aiemmat lähetykset';
    archiveWrap.appendChild(archiveTitle);

    this._archiveList = document.createElement('ul');
    this._archiveList.className = 'tr-archive-list';
    archiveWrap.appendChild(this._archiveList);
    root.appendChild(archiveWrap);

    // Hidden <audio> element
    this._audio = document.createElement('audio');
    this._audio.preload = 'none';
    this._audio.addEventListener('error', function () {
      self._setStatus('Toistovirhe — yritetään uudelleen…', true);
      self._playing = false;
      self._updatePlayBtn();
    });
    root.appendChild(this._audio);
  };

  // ---------------------------------------------------------------------------
  // Polling — check /api/status and /api/archive periodically
  // ---------------------------------------------------------------------------
  TubeRadio.prototype._poll = function () {
    var self = this;
    this._checkStatus();
    this._checkArchive();
    this._pollTimer = setInterval(function () {
      self._checkStatus();
      self._checkArchive();
    }, this.opts.pollInterval);
  };

  TubeRadio.prototype._checkStatus = function () {
    var self = this;
    fetchJSON(this.opts.statusUrl, function (err, data) {
      if (err || !data) {
        self._setLive(false);
        self._setStatus('Yhteysvirhe', true);
        return;
      }
      self._setLive(data.live);
      if (data.live) {
        self._setStatus('Lähetyksessä · suorana nyt');
      } else {
        self._setStatus('Poissa · odotetaan lähetystä');
      }
    });
  };

  TubeRadio.prototype._checkArchive = function () {
    var self = this;
    fetchJSON(this.opts.archiveUrl, function (err, data) {
      if (err || !data || !data.recordings) return;
      self._renderArchive(data.recordings);
    });
  };

  // ---------------------------------------------------------------------------
  // Live state
  // ---------------------------------------------------------------------------
  TubeRadio.prototype._setLive = function (live) {
    this._live = live;
    this._dot.className = 'tr-dot' + (live ? ' live' : '');
    this._badge.className = 'tr-badge' + (live ? ' live' : '');
    this._badge.textContent = live ? 'lähetyksessä' : 'poissa';
    this._playBtn.disabled = !live;

    // If we were playing and the stream went down, stop.
    if (!live && this._playing) {
      this._stopPlayback();
    }
  };

  // ---------------------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------------------
  TubeRadio.prototype._togglePlay = function () {
    if (this._playing) {
      this._stopPlayback();
    } else {
      this._reportEvent({ type: 'live-play' });
      this._startPlayback();
    }
  };

  TubeRadio.prototype._reportEvent = function (payload) {
    if (!this.opts.statsUrl) return;
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', this.opts.statsUrl);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify(payload));
    } catch (e) {
      // Silently ignore — stats are optional
    }
  };

  TubeRadio.prototype._startPlayback = function () {
    var self = this;
    this._setStatus('Yhdistetään…');

    var audio = this._audio;
    var url = this.opts.streamUrl;

    // Native HLS (Safari / iOS)
    if (audio.canPlayType('application/vnd.apple.mpegurl')) {
      audio.src = url;
      audio.play().then(function () {
        self._playing = true;
        self._updatePlayBtn();
        self._setStatus('Toistetaan · suorana');
      }).catch(function (e) {
        self._setStatus('Toisto estetty — paina Toista', true);
      });
      return;
    }

    // HLS.js path — load dynamically if not already present
    if (typeof window.Hls !== 'undefined') {
      self._attachHls(url);
      return;
    }

    var script = document.createElement('script');
    script.src = HLS_JS_CDN;
    script.onload = function () { self._attachHls(url); };
    script.onerror = function () {
      self._setStatus('HLS-kirjaston lataus epäonnistui', true);
    };
    document.head.appendChild(script);
  };

  TubeRadio.prototype._attachHls = function (url) {
    var self = this;

    if (!window.Hls.isSupported()) {
      this._setStatus('Selain ei tue HLS:ää', true);
      return;
    }

    if (this.hls) { this.hls.destroy(); }

    this.hls = new window.Hls({ enableWorker: true });
    this.hls.loadSource(url);
    this.hls.attachMedia(this._audio);

    this.hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
      self._audio.play().then(function () {
        self._playing = true;
        self._updatePlayBtn();
        self._setStatus('Toistetaan · suorana');
        self._applyVolume();
      }).catch(function () {
        self._setStatus('Toisto estetty — paina Toista', true);
      });
    });

    this.hls.on(window.Hls.Events.ERROR, function (_evt, data) {
      if (data.fatal) {
        self._setStatus('Lähetysvirhe — yritetään uudelleen…', true);
        self._playing = false;
        self._updatePlayBtn();
      }
    });
  };

  TubeRadio.prototype._stopPlayback = function () {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    this._audio.pause();
    this._audio.removeAttribute('src');
    this._audio.load();
    this._playing = false;
    this._updatePlayBtn();
    this._setStatus(this._live ? 'Tauolla · lähetys käynnissä' : 'Poissa · odotetaan lähetystä');
  };

  TubeRadio.prototype._updatePlayBtn = function () {
    this._playBtn.innerHTML = this._playing ? iconPause() : iconPlay();
    this._playBtn.setAttribute('aria-label', this._playing ? 'Tauko' : 'Toista');
  };

  // ---------------------------------------------------------------------------
  // Volume
  // ---------------------------------------------------------------------------
  TubeRadio.prototype._applyVolume = function () {
    var v = this._volume;
    if (this._audio) this._audio.volume = v;
    this._volSlider.style.setProperty('--val', Math.round(v * 100) + '%');
    this._volIcon.innerHTML = iconVolume(v === 0 ? 'mute' : v < 0.5 ? 'low' : 'high');
  };

  TubeRadio.prototype._toggleMute = function () {
    if (this._volume > 0) {
      this._prevVolume = this._volume;
      this._volume = 0;
    } else {
      this._volume = this._prevVolume || 0.7;
    }
    this._volSlider.value = String(this._volume);
    this._applyVolume();
  };

  // ---------------------------------------------------------------------------
  // Status line
  // ---------------------------------------------------------------------------
  TubeRadio.prototype._setStatus = function (msg, isError) {
    this._statusEl.textContent = msg;
    this._statusEl.className = 'tr-status' + (isError ? ' error' : '');
  };

  // ---------------------------------------------------------------------------
  // Archive list
  // ---------------------------------------------------------------------------
  TubeRadio.prototype._renderArchive = function (recordings) {
    var list = this._archiveList;
    list.innerHTML = '';

    if (!recordings || recordings.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'tr-archive-empty';
      empty.textContent = 'Ei tallennuksia.';
      list.appendChild(empty);
      return;
    }

    var self = this;
    recordings.forEach(function (rec) {
      var li = document.createElement('li');
      li.className = 'tr-archive-item';

      var dateEl = document.createElement('div');
      dateEl.className = 'tr-archive-date';
      dateEl.title = rec.filename;
      dateEl.textContent = formatDate(rec.startedAt) + (rec.streamName ? ' · ' + rec.streamName : '');
      li.appendChild(dateEl);

      var dlLink = document.createElement('a');
      dlLink.className = 'tr-archive-dl';
      dlLink.href = rec.url;
      dlLink.download = rec.filename;
      dlLink.textContent = '↓ MP3';
      (function (filename) {
        dlLink.addEventListener('click', function () {
          self._reportEvent({ type: 'archive-play', filename: filename });
        });
      }(rec.filename));
      li.appendChild(dlLink);

      list.appendChild(li);
    });
  };

  // ---------------------------------------------------------------------------
  // Destroy
  // ---------------------------------------------------------------------------
  TubeRadio.prototype.destroy = function () {
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (this.hls) this.hls.destroy();
    if (this._audio) { this._audio.pause(); this._audio.src = ''; }
  };

  // ---------------------------------------------------------------------------
  // Auto-initialise any <div data-tuberadio> elements
  // ---------------------------------------------------------------------------
  function autoInit() {
    var elements = document.querySelectorAll('[data-tuberadio]');
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      // Don't double-init
      if (el._tuberadio) continue;
      el._tuberadio = new TubeRadio({
        container:   el,
        streamUrl:   el.getAttribute('data-stream-url')  || DEFAULTS.streamUrl,
        statusUrl:   el.getAttribute('data-status-url')  || DEFAULTS.statusUrl,
        archiveUrl:  el.getAttribute('data-archive-url') || DEFAULTS.archiveUrl,
        statsUrl:    el.getAttribute('data-stats-url')   || DEFAULTS.statsUrl,
        title:       el.getAttribute('data-title')        || DEFAULTS.title,
        pollInterval: Number(el.getAttribute('data-poll-interval')) || DEFAULTS.pollInterval,
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }

  // Expose constructor globally
  window.TubeRadio = TubeRadio;

}(window, document));
