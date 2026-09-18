// AI review providers for the browser.
//   anthropic : calls api.anthropic.com directly with the user's own key (bring your own key)
//   cli       : the local companion server (npm start) that runs the `claude` CLI on this machine
import { REVIEW_SYSTEM_PROMPT, buildReviewInput, parseReview } from './review-core.js';
import { isLocalhost, localHeaders } from './local.js';

// Prices are USD per million tokens, used only for the on-screen estimate.
export const MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5 (default)', input: 5, output: 25, effort: true },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', input: 2, output: 10, effort: true },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fastest, cheapest)', input: 1, output: 5, effort: false },
];
export const DEFAULT_MODEL = 'claude-opus-5';
const API_URL = 'https://api.anthropic.com/v1/messages';

export function looksLikeKey(k) {
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test((k || '').trim());
}

export async function reviewWithAnthropic({ apiKey, model, name, original, edited, styleNotes, signal }) {
  const m = MODELS.find((x) => x.id === model) || MODELS[0];
  const body = {
    model: m.id,
    max_tokens: 8000,
    system: REVIEW_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildReviewInput({ name, original, edited, styleNotes }) }],
  };
  if (m.effort) body.output_config = { effort: 'low' };

  const started = performance.now();
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // Required by the API for requests made from a browser page with a key.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('could not reach api.anthropic.com (offline, blocked, or a network error)');
  }
  const ms = Math.round(performance.now() - started);
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || res.statusText || 'unknown error';
    if (res.status === 401) throw new Error('the API key was rejected (401). check it in settings.');
    if (res.status === 429) throw new Error('rate limited by the API (429). try again in a moment.');
    throw new Error(`API error ${res.status}: ${msg}`);
  }
  if (data.stop_reason === 'refusal') throw new Error('the model declined to review this file');
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const review = parseReview(text);
  if (!review) throw new Error('the reviewer reply could not be parsed: ' + text.slice(0, 200));
  const u = data.usage || {};
  const costUsd = ((u.input_tokens || 0) * m.input + (u.output_tokens || 0) * m.output) / 1e6;
  return { review, ms, model: m.id, costUsd, provider: 'anthropic' };
}

export async function probeCli() {
  if (!isLocalhost()) return null; // the companion only ever runs locally
  try {
    const r = await fetch('./api/cli-status', { cache: 'no-store', credentials: 'omit', headers: localHeaders() });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.ok ? j : null;
  } catch {
    return null;
  }
}

export async function reviewWithCli({ name, original, edited, styleNotes, signal }) {
  const r = await fetch('./api/cli-review', {
    method: 'POST',
    credentials: 'omit',
    headers: localHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ name, original, edited, styleNotes }),
    signal,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || `local reviewer error ${r.status}`);
  return { ...j, provider: 'cli' };
}
