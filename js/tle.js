// Orbital element loading. All network access is behind loadTLEs(), so a proxy
// or backend can be swapped in without touching the rest of the app.

const TLE_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=iridium-NEXT&FORMAT=tle';
const SNAPSHOT_URL = 'data/tle-snapshot.txt';
const CACHE_KEY = 'iridium-display.tle.v1';
const MAX_CACHE_AGE_MS = 3 * 60 * 60 * 1000; // 3 hours

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed.text || !parsed.fetchedAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(text) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ text, fetchedAt: Date.now() }));
  } catch {
    // Private browsing or a full quota. The cache is optional, so ignore it.
  }
}

function looksLikeTLE(text) {
  // CelesTrak serves CRLF line endings, so match on \n and ignore the \r.
  return /(^|\n)1 \d{5}/.test(text);
}

/**
 * Fetch Iridium elements. Tries the network, then localStorage, then the
 * bundled snapshot.
 *
 * @param {{force?: boolean}} options force a fetch even when the cache is fresh
 * @returns {Promise<{text: string, fetchedAt: number, source: 'network'|'cache'|'snapshot'}>}
 */
export async function loadTLEs({ force = false } = {}) {
  const cached = readCache();
  const cacheIsFresh = cached && Date.now() - cached.fetchedAt < MAX_CACHE_AGE_MS;

  if (cacheIsFresh && !force) {
    return { ...cached, source: 'cache' };
  }

  try {
    const res = await fetch(TLE_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`CelesTrak returned HTTP ${res.status}`);
    const text = await res.text();
    if (!looksLikeTLE(text)) throw new Error('CelesTrak response was not TLE data');
    writeCache(text);
    return { text, fetchedAt: Date.now(), source: 'network' };
  } catch (err) {
    console.warn('Live TLE fetch failed, falling back:', err);
  }

  if (cached) return { ...cached, source: 'cache' };

  const res = await fetch(SNAPSHOT_URL);
  if (!res.ok) throw new Error('No TLE data available: network, cache and snapshot all failed');
  return { text: await res.text(), fetchedAt: null, source: 'snapshot' };
}

/** Age as text, e.g. "2 h 14 m old". */
export function formatAge(fetchedAt) {
  if (!fetchedAt) return 'bundled snapshot';
  const mins = Math.max(0, Math.round((Date.now() - fetchedAt) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} m old`;
  const h = Math.floor(mins / 60);
  return `${h} h ${mins % 60} m old`;
}
