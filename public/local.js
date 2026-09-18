// The local companion prints a URL with ?t=<key>. The page keeps that key for the tab and sends it
// with every call to the companion's API, so other processes on the machine cannot use the API.
import { APP_SLUG } from './config.js';

const TOKEN_KEY = `${APP_SLUG}.local-key`;

export function isLocalhost() {
  const h = typeof location !== 'undefined' ? location.hostname : '';
  return h === 'localhost' || h === '127.0.0.1';
}

// Move the key from the URL into sessionStorage and drop it from the address bar.
export function captureLocalKey() {
  if (!isLocalhost()) return;
  try {
    const u = new URL(location.href);
    const t = u.searchParams.get('t');
    if (t && /^[a-f0-9]{32}$/.test(t)) {
      sessionStorage.setItem(TOKEN_KEY, t);
      u.searchParams.delete('t');
      history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
    }
  } catch {}
}

export function localKey() {
  try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

export function localHeaders(extra = {}) {
  const t = localKey();
  return t ? { ...extra, 'X-Session-Token': t } : { ...extra };
}
