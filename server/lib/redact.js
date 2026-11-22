// Removes secrets from text before it is logged, returned or put in an error.
// Pure: no I/O, no clock. Used for config values and ffmpeg stderr.

const MARK = '[REDACTED]';
const SENSITIVE_PARAMS = 'token|key|cid|streamid|secret|password';

// Literal replacement of each secret, longest first so a secret that contains
// another one is removed whole.
const replaceSecrets = (text, secrets) => {
  const list = (Array.isArray(secrets) ? secrets : [])
    .filter((s) => typeof s === 'string' && s.length > 0)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const s of list) out = out.split(s).join(MARK);
  return out;
};

export function redact(text, secrets = []) {
  if (typeof text !== 'string') return '';
  let out = replaceSecrets(text, secrets);

  // scheme://user:pass@host -> scheme://[REDACTED]@host
  out = out.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/?#@]+@/g, `$1${MARK}@`);

  // rtmp:// and rtmps://: the last path segment is the stream key (only when the path has two or more segments)
  out = out.replace(/(rtmps?:\/\/[^\s/?#'"<>]+)(\/[^\s?#'"<>]*)/gi, (match, origin, path) => {
    const trailing = path.endsWith('/') ? '/' : '';
    const core = trailing ? path.slice(0, -1) : path;
    const segments = core.slice(1).split('/');
    if (segments.length < 2) return match;
    return `${origin}${core.slice(0, core.lastIndexOf('/') + 1)}${MARK}${trailing}`;
  });

  // ?token=... and &token=... query values (case-insensitive names)
  out = out.replace(new RegExp(`([?&])(${SENSITIVE_PARAMS})=[^&\\s#'"]*`, 'gi'), `$1$2=${MARK}`);

  return out;
}
