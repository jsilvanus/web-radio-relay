// Browser side of the viewer pages: the EventSource client for GET /api/v1/viewer/{key} and the DOM
// panels (caption, section heading, hymn, picture, language picker). Plain ES module, no build step.
//
// Every piece of event text goes in with textContent or createElement. Nothing from the stream is
// ever assigned to innerHTML. The pure helpers live in viewer-utils.js.

import {
  resolveViewerText,
  collectLangTexts,
  splitBreaks,
  languagesOf,
  assetUrl,
  hymnLines,
  parseLang,
} from './viewer-utils.js';

const STORE_KEY = 'relay.viewer.lang';
const RETRY_MS = 3000;

const LANG_LABELS = { '': 'Alkuperäinen ja käännös', original: 'Alkuperäinen', all: 'Kaikki kielet' };

/** The chosen language, kept in localStorage. Storage can be blocked (private windows): always optional. */
export function readStoredLang() {
  try {
    return parseLang(localStorage.getItem(STORE_KEY));
  } catch {
    return '';
  }
}

export function storeLang(lang) {
  try {
    localStorage.setItem(STORE_KEY, lang);
  } catch {
    /* blocked storage: the choice lasts for this page view only */
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Put caption text into a node: each <br> becomes a line break element, never markup. */
export function renderText(node, text) {
  node.textContent = '';
  splitBreaks(text).forEach((part, i) => {
    if (i > 0) node.appendChild(document.createElement('br'));
    node.appendChild(document.createTextNode(part));
  });
}

/**
 * Build the viewer panels inside `root` and return the handlers the SSE client calls.
 * @param {HTMLElement} root
 * @param {object} [options]
 * @param {boolean} [options.section=true]   section heading
 * @param {boolean} [options.graphics=true]  hymn and picture panels
 * @param {boolean} [options.captions=true]  caption text
 * @param {boolean} [options.picker=false]   language picker (options come from the languages seen so far)
 * @param {string}  [options.lang='']        starting language: '', 'original', 'all' or a code
 * @param {number}  [options.fontSize]       caption size in rem
 * @param {(lang: string) => void} [options.onLangChange]
 */
export function mountViewerPanel(root, options = {}) {
  const o = { section: true, graphics: true, captions: true, picker: false, lang: '', ...options };
  let lang = parseLang(o.lang);
  const state = { last: null, langTexts: {}, languages: [] };

  root.classList.add('vw-panel');
  if (o.fontSize) root.style.setProperty('--vw-caption-size', `${o.fontSize}rem`);

  let picker = null;
  if (o.picker) {
    picker = el('select', 'vw-picker');
    picker.setAttribute('aria-label', 'Kieli');
    picker.addEventListener('change', () => {
      lang = parseLang(picker.value);
      if (o.onLangChange) o.onLangChange(lang);
      renderCaptions();
    });
    root.appendChild(picker);
  }

  let sectionEl = null;
  if (o.section) {
    sectionEl = el('div', 'vw-section');
    sectionEl.hidden = true;
    root.appendChild(sectionEl);
  }

  let hymnEl = null;
  let hymnTitle = null;
  let hymnBody = null;
  let pictureEl = null;
  let pictureImg = null;
  if (o.graphics) {
    hymnEl = el('section', 'vw-hymn');
    hymnEl.hidden = true;
    hymnTitle = el('div', 'vw-hymn-title');
    hymnBody = el('div', 'vw-hymn-lines');
    hymnEl.append(hymnTitle, hymnBody);
    pictureEl = el('figure', 'vw-picture');
    pictureEl.hidden = true;
    pictureImg = document.createElement('img');
    pictureImg.alt = '';
    pictureEl.appendChild(pictureImg);
    root.append(hymnEl, pictureEl);
  }

  let captionEl = null;
  if (o.captions) {
    captionEl = el('div', 'vw-captions');
    captionEl.setAttribute('aria-live', 'polite');
    root.appendChild(captionEl);
  }

  function setSection(title) {
    if (!sectionEl) return;
    sectionEl.textContent = typeof title === 'string' ? title : '';
    sectionEl.hidden = !sectionEl.textContent;
  }

  function refreshPicker() {
    if (!picker) return;
    const wanted = ['', 'original', ...state.languages];
    if (state.languages.length) wanted.push('all');
    if (lang && !wanted.includes(lang)) wanted.push(lang);
    const current = [...picker.options].map((opt) => opt.value);
    if (current.join('|') !== wanted.join('|')) {
      picker.textContent = '';
      for (const value of wanted) {
        const opt = el('option', '', LANG_LABELS[value] ?? value);
        opt.value = value;
        picker.appendChild(opt);
      }
    }
    picker.value = lang;
  }

  function renderCaptions() {
    if (!captionEl) return;
    captionEl.textContent = '';
    if (!state.last) return;
    if (lang === 'all') {
      const cols = el('div', 'vw-cols');
      for (const [code, text] of Object.entries(state.langTexts)) {
        const col = el('div', 'vw-col');
        col.appendChild(el('div', 'vw-col-label', code === 'original' ? 'Alkuperäinen' : code));
        const p = el('p', 'vw-caption');
        renderText(p, text);
        col.appendChild(p);
        cols.appendChild(col);
      }
      captionEl.appendChild(cols);
      return;
    }
    const p = el('p', 'vw-caption');
    renderText(p, resolveViewerText(state.last, lang));
    captionEl.appendChild(p);
  }

  function showHymn(g) {
    const number = g.kind === 'hymn-verse' && g.hymnNumber != null ? String(g.hymnNumber) : '';
    const title = typeof g.title === 'string' ? g.title : '';
    const lines = hymnLines(g);
    if (!number && !title && !lines.length) return hideGraphics();
    hymnTitle.textContent = [number, title].filter(Boolean).join(' ');
    hymnBody.textContent = '';
    for (const line of lines) hymnBody.appendChild(el('p', '', line));
    hymnEl.hidden = false;
    pictureEl.hidden = true;
  }

  function showPicture(g) {
    const url = assetUrl(g.assetId);
    if (!url) return hideGraphics();
    pictureImg.src = url;
    pictureImg.alt = typeof g.title === 'string' ? g.title : '';
    pictureEl.hidden = false;
    hymnEl.hidden = true;
  }

  function hideGraphics() {
    if (hymnEl) hymnEl.hidden = true;
    if (pictureEl) pictureEl.hidden = true;
  }

  refreshPicker();
  renderCaptions();

  return {
    /** A `caption` event (LCYT payload). A translation re-sent with the same sequence replaces the text. */
    caption(data) {
      if (!data || typeof data !== 'object') return;
      if (data.codes && typeof data.codes === 'object' && 'section' in data.codes) {
        setSection(data.codes.section);
      }
      state.last = data;
      Object.assign(state.langTexts, collectLangTexts(data));
      for (const code of languagesOf(data)) {
        if (!state.languages.includes(code)) state.languages.push(code);
      }
      refreshPicker();
      renderCaptions();
    },
    /** A `section` event: the heading. */
    section(data) {
      if (data && typeof data === 'object') setSection(data.title);
    },
    /** A `graphic` event: hymn verse, text, picture, or clear. */
    graphic(g) {
      if (!o.graphics || !g || typeof g !== 'object') return;
      if (g.kind === 'clear') hideGraphics();
      else if (g.kind === 'hymn-verse' || g.kind === 'text') showHymn(g);
      else if (g.kind === 'slide' || g.kind === 'image') showPicture(g);
    },
    setLang(value) {
      lang = parseLang(value);
      refreshPicker();
      renderCaptions();
    },
    getLang() {
      return lang;
    },
  };
}

/**
 * Open the viewer SSE for one stream and feed its events to a panel.
 * `mode` is 'live' (visitors in the building: no delay) or 'delayed' (remote listeners).
 * The browser reconnects by itself; a closed connection is reopened after RETRY_MS.
 * @returns {{ close: () => void }}
 */
export function connectViewer({ key, mode = 'live', panel, onStatus = () => {}, base = '' }) {
  const url = `${base}/api/v1/viewer/${encodeURIComponent(key)}?mode=${mode === 'delayed' ? 'delayed' : 'live'}`;
  let source = null;
  let timer = null;
  let closed = false;

  const on = (fn) => (event) => {
    try {
      fn(JSON.parse(event.data));
    } catch {
      /* malformed event: ignore */
    }
  };

  function open() {
    if (closed) return;
    source = new EventSource(url);
    source.addEventListener('connected', () => onStatus('connected'));
    source.addEventListener('caption', on((d) => panel.caption?.(d)));
    source.addEventListener('section', on((d) => panel.section?.(d)));
    source.addEventListener('graphic', on((d) => panel.graphic?.(d)));
    source.onerror = () => {
      if (closed) return;
      onStatus('reconnecting');
      // readyState CLOSED means the browser gives up on its own (e.g. an error answer): retry here.
      if (source.readyState === EventSource.CLOSED) {
        source.close();
        timer = setTimeout(open, RETRY_MS);
      }
    };
  }

  open();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      if (source) source.close();
    },
  };
}

/**
 * Ask for a screen wake lock where the browser supports it, and again when the page becomes visible.
 * Silent when unsupported or refused.
 */
export function keepScreenAwake() {
  let sentinel = null;
  const acquire = async () => {
    if (sentinel || !navigator.wakeLock || document.visibilityState !== 'visible') return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => {
        sentinel = null;
      });
    } catch {
      sentinel = null;
    }
  };
  document.addEventListener('visibilitychange', acquire);
  acquire();
}

/**
 * Play an HLS URL in a video element: hls.js when loaded, the element's own HLS support otherwise.
 * `onFatal` runs on an unrecoverable error.
 * @returns {object|null} the hls.js instance, if any
 */
export function playHls(video, url, onFatal = () => {}) {
  const Hls = window.Hls;
  if (Hls && Hls.isSupported()) {
    const hls = new Hls({ lowLatencyMode: false });
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else onFatal();
    });
    return hls;
  }
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    return null;
  }
  onFatal();
  return null;
}
