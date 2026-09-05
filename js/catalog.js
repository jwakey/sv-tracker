// Search of CelesTrak's general perturbations catalogue.
//
// tle.js fetches the constellation itself, as one GROUP query. This is the
// other half: any object in the catalogue, by name or by NORAD ID, so a rocket
// body or a debris fragment can be put on the map beside the Iridium it is
// closing on.
//
// Queried per search rather than downloaded whole. The active catalogue is a
// few megabytes for some 12,000 objects, and gp.php already does the substring
// match server side, so holding a local copy would buy nothing but a slow first
// search. Results are cached per query for the session, and the caller debounces,
// so a burst of typing costs one request.

import { parseTLEs, meanAltitudeKm, raanDeg, epochDate } from './propagate.js';

const GP_URL = 'https://celestrak.org/NORAD/elements/gp.php';

/** Below this a name query matches half the catalogue, so it is not sent. */
export const MIN_QUERY_LENGTH = 3;

const MAX_RESULTS = 40;

// Query text -> results. Only ever grows, and a session's worth of searches is
// a few hundred kilobytes at worst.
const cache = new Map();

/** CelesTrak's "nothing matched" bodies, which arrive as HTTP 200 text. */
function isEmptyResponse(text) {
  return /no gp data found/i.test(text) || !/(^|\n)1 \d{5}/.test(text);
}

/**
 * One gp.php query, capped.
 *
 * A broad name matches a lot: "starlink" is ten thousand objects and nearly two
 * megabytes. Only the first MAX_RESULTS are parsed into satrecs - the list can
 * show no more than that anyway - but the whole response is counted first, so
 * the panel can say how much it is not showing rather than silently truncating.
 *
 * @returns {Promise<{records: Array, total: number}>}
 */
async function gpQuery(params, signal) {
  const url = `${GP_URL}?${params}&FORMAT=tle`;
  const res = await fetch(url, { signal });
  // gp.php answers a query that matched nothing with 404 and the body
  // "No GP data found", so a 404 here is an empty result, not a failure.
  if (res.status === 404) return { records: [], total: 0 };
  if (!res.ok) throw new Error(`CelesTrak returned HTTP ${res.status}`);

  const text = await res.text();
  if (isEmptyResponse(text)) return { records: [], total: 0 };

  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  const total = Math.floor(lines.length / 3);
  const head = lines.slice(0, MAX_RESULTS * 3).join('\n');
  return { records: parseTLEs(head), total };
}

/**
 * Look an object up in the catalogue.
 *
 * All digits is read as a NORAD ID first, since that is what a bare number
 * almost always is; if the catalogue has no such object the same digits are
 * tried as a name, so "1998" still finds anything named for that year.
 *
 * @param {string} query
 * @param {{signal?: AbortSignal}} options
 * @returns {Promise<{results: Array, total: number}>} `total` is how many the
 * catalogue matched, which may be far more than `results` holds
 */
export async function searchCatalog(query, { signal } = {}) {
  const q = query.trim();
  if (q.length < MIN_QUERY_LENGTH) return { results: [], total: 0 };

  const key = q.toLowerCase();
  if (cache.has(key)) return cache.get(key);

  const numeric = /^\d{1,9}$/.test(q);
  let found = { records: [], total: 0 };

  if (numeric) found = await gpQuery(`CATNR=${encodeURIComponent(q)}`, signal);
  if (!found.records.length) found = await gpQuery(`NAME=${encodeURIComponent(q)}`, signal);

  const out = { results: found.records.map(describe), total: found.total };
  cache.set(key, out);
  return out;
}

/** Re-fetch one object's elements by NORAD ID. Null if it is no longer listed. */
export async function fetchByCatalogNumber(id, { signal } = {}) {
  const { records } = await gpQuery(`CATNR=${encodeURIComponent(id)}`, signal);
  return records.length ? describe(records[0]) : null;
}

/**
 * International designator, read off line 1 of the TLE.
 *
 * Columns 10-17 hold it packed - "98067A" - and satellite.js does not keep it,
 * so it is parsed here and expanded to the usual form. Two-digit years wrap at
 * Sputnik: 57 and up are 19xx, everything below is 20xx.
 *
 * @returns {string} e.g. "1998-067A", or '' if the field is blank
 */
function internationalDesignator(line1) {
  const packed = String(line1 || '').slice(9, 17).trim();
  const m = /^(\d{2})(\d{3})([A-Z]{0,3})$/.exec(packed);
  if (!m) return packed;
  const year = Number(m[1]) >= 57 ? `19${m[1]}` : `20${m[1]}`;
  return `${year}-${m[2]}${m[3]}`;
}

/** Add the fields the search list and the detail panel read. */
function describe(record) {
  return {
    ...record,
    intlDes: internationalDesignator(record.line1),
    epoch: epochDate(record.satrec),
    meanAltKm: meanAltitudeKm(record.satrec),
  };
}

/**
 * A short label for the map, where a name competes with 66 others for space.
 *
 * Catalogue names run long and carry suffixes the map cannot show - "COSMOS
 * 2251 DEB", "STARLINK-1234 [DTC]" - so the bracketed part goes and the rest is
 * cut to something that still identifies the object at a glance.
 */
function shortLabel(name) {
  const trimmed = String(name).replace(/\s*\[.*$/, '').trim();
  return trimmed.length > 16 ? `${trimmed.slice(0, 15)}…` : trimmed;
}

/**
 * Turn a catalogue record into a satellite the rest of the app can carry.
 *
 * Tracked objects join state.sats alongside the constellation, so every view
 * draws them, picks them and shows their detail without knowing they came from
 * somewhere else. What sets them apart is three flags:
 *
 *   status 'tracked' keeps them out of the roster counts, the plane rings and
 *   the ground-site visibility lists, all of which test status;
 *
 *   tracked makes isVisible() and isHighlighted() pass them through, so no
 *   display filter can hide an object that was deliberately added, and each
 *   one wears a selection ring and a direction arrow;
 *
 *   noFootprint suppresses the coverage disc. It is a comms figure, and these
 *   are not comms assets - and at a catalogue object's altitude the disc can
 *   swallow a hemisphere.
 */
export function toTracked(record) {
  return {
    ...record,
    tracked: true,
    noFootprint: true,
    status: 'tracked',
    statusSource: 'catalog',
    label: shortLabel(record.name),
    plane: null,
    rosterPlane: null,
    vehicle: null,
    raan: raanDeg(record.satrec),
    meanAltKm: meanAltitudeKm(record.satrec),
  };
}
