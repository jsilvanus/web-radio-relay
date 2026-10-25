/**
 * Tuberadio dev site — main.js
 *
 * Responsibilities:
 *  1. Generate and update the embed code snippet as the user edits the config inputs.
 *  2. Handle the "Copy" button with clipboard API + fallback.
 *  3. Keep the live player widget in sync with the config fields so devs can see
 *     config changes reflected immediately.
 */

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------
const cfgTitle   = /** @type {HTMLInputElement} */ (document.getElementById('cfg-title'));
const cfgStream  = /** @type {HTMLInputElement} */ (document.getElementById('cfg-stream'));
const cfgStatus  = /** @type {HTMLInputElement} */ (document.getElementById('cfg-status'));
const cfgArchive = /** @type {HTMLInputElement} */ (document.getElementById('cfg-archive'));
const cfgScript  = /** @type {HTMLInputElement} */ (document.getElementById('cfg-script'));
const embedCode  = document.getElementById('embed-code');
const copyBtn    = document.getElementById('copy-btn');
const playerEl   = document.getElementById('player');

// ---------------------------------------------------------------------------
// Generate embed code
// ---------------------------------------------------------------------------
function buildEmbedCode() {
  const title   = cfgTitle.value.trim()   || 'My Radio';
  const stream  = cfgStream.value.trim()  || '/hls/stream.m3u8';
  const status  = cfgStatus.value.trim()  || '/api/status';
  const archive = cfgArchive.value.trim() || '/api/archive';
  const script  = cfgScript.value.trim()  || 'https://your-domain.com/tuberadio.js';

  return [
    `<!-- Tuberadio embed -->`,
    `<div`,
    `  data-tuberadio`,
    `  data-title="${escHtml(title)}"`,
    `  data-stream-url="${escHtml(stream)}"`,
    `  data-status-url="${escHtml(status)}"`,
    `  data-archive-url="${escHtml(archive)}"`,
    `></div>`,
    `<script src="${escHtml(script)}"><\/script>`,
  ].join('\n');
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function updateCode() {
  if (embedCode) embedCode.textContent = buildEmbedCode();
}

// ---------------------------------------------------------------------------
// Re-initialise the live demo player when config fields change
// ---------------------------------------------------------------------------
function refreshPlayer() {
  if (!playerEl || !window.TubeRadio) return;

  // Destroy existing instance if present
  if (playerEl._tuberadio) {
    playerEl._tuberadio.destroy();
    playerEl._tuberadio = null;
  }

  // Update data attributes so TubeRadio picks them up
  playerEl.setAttribute('data-title',       cfgTitle.value.trim()   || 'My Radio');
  playerEl.setAttribute('data-stream-url',  cfgStream.value.trim()  || '/hls/stream.m3u8');
  playerEl.setAttribute('data-status-url',  cfgStatus.value.trim()  || '/api/status');
  playerEl.setAttribute('data-archive-url', cfgArchive.value.trim() || '/api/archive');

  playerEl._tuberadio = new window.TubeRadio({
    container:  playerEl,
    title:      playerEl.getAttribute('data-title'),
    streamUrl:  playerEl.getAttribute('data-stream-url'),
    statusUrl:  playerEl.getAttribute('data-status-url'),
    archiveUrl: playerEl.getAttribute('data-archive-url'),
  });
}

// ---------------------------------------------------------------------------
// Copy button
// ---------------------------------------------------------------------------
function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback for non-secure contexts (e.g. plain http dev)
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(ta);
  }
  return Promise.resolve();
}

if (copyBtn) {
  copyBtn.addEventListener('click', () => {
    const text = buildEmbedCode();
    copyToClipboard(text)
      .then(() => {
        copyBtn.textContent = 'Copied!';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
          copyBtn.classList.remove('copied');
        }, 2000);
      })
      .catch(() => {
        copyBtn.textContent = 'Failed';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
      });
  });
}

// ---------------------------------------------------------------------------
// Wire up config inputs — update code panel on every keystroke;
// refresh the player only after the user stops typing (debounced)
// ---------------------------------------------------------------------------
let refreshTimer = null;

function onConfigChange() {
  updateCode();
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshPlayer, 600);
}

[cfgTitle, cfgStream, cfgStatus, cfgArchive].forEach((el) => {
  if (el) el.addEventListener('input', onConfigChange);
});

// cfgScript only affects the embed code, not the live player
if (cfgScript) cfgScript.addEventListener('input', updateCode);

// ---------------------------------------------------------------------------
// Initial render
// ---------------------------------------------------------------------------
updateCode();
