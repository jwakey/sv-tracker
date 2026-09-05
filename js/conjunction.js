// Close-approach screening between one tracked object and the constellation.
//
// This is a screening tool, not a conjunction assessment. It answers "which
// Iridium does this thing get near, and when" from public two-line elements.
// It does not produce a probability of collision: that needs covariances, and a
// TLE does not carry one. See ACCURACY_NOTE at the bottom.
//
// The search is the standard sieve, cheapest filter first:
//
//   1. Apsis filter. Two orbits whose altitude shells never overlap cannot
//      approach, whatever their phasing. This is arithmetic on the elements and
//      throws out most of the catalogue - a GEO object clears the whole
//      constellation before anything is propagated.
//
//   2. Coarse scan. Both objects are propagated on a fixed step across the
//      window and the range between them sampled. Every local minimum of that
//      sampled range brackets a real close approach: range falls then rises, so
//      the true minimum lies between the samples either side of the dip. The
//      step is far too coarse to read a miss distance off - at 15 km/s of
//      relative motion the pair covers 900 km between samples - but it does not
//      have to be. It only has to find the dip.
//
//   3. Refinement. Each bracketed dip is minimised by golden-section search
//      down to a fraction of a second. The range function is smooth and has one
//      minimum inside the bracket, which is exactly what golden section wants,
//      and it converges in around 40 propagations per event.
//
// The target is propagated once for the whole coarse scan and the samples
// reused for every candidate, so the cost is one pass per candidate rather than
// one per pair.

import { propagateEci, propagateSat, apsisRadiiKm } from './propagate.js';

export const DEFAULT_COARSE_STEP_SEC = 60;

// Distance bands, shared by the sidebar's ranking and the line the map draws
// between a paired satellites. They are distance, nothing more: a TLE cannot
// support a probability of collision, so neither number is a risk threshold.
// CLOSE is where two objects stop merely sharing a shell; CRITICAL is where the
// miss distance has fallen to the order of the element error itself, and the
// only honest reading is "too close to tell apart".
export const CLOSE_APPROACH_KM = 25;
export const CRITICAL_APPROACH_KM = 5;

// Golden-section constant: the fraction of an interval the two probes sit in
// from each end.
const INV_PHI = (Math.sqrt(5) - 1) / 2;

// Stop refining once the bracket is this short. The elements are not good to
// anything like this, but it costs three or four extra propagations and makes
// the reported second a true minimum rather than wherever the search stopped.
const REFINE_TOLERANCE_MS = 50;

// Slack on the apsis filter, in km, over and above the screening distance.
// Mean elements describe a shell the osculating orbit wanders either side of,
// and Iridium's is near enough circular that a tight filter would start
// dropping real geometry.
const APSIS_MARGIN_KM = 50;

// Candidates between event-loop yields. One candidate is a full coarse pass -
// a few milliseconds - so this keeps the longest blocking stretch short enough
// that the clock does not visibly stutter while a screening runs.
const CANDIDATES_PER_YIELD = 4;

export const ACCURACY_NOTE = 'Screening only. Not meant for decision making.';

function rangeKm(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Whether two orbits ever reach the same altitude, within a margin. */
function shellsOverlap(a, b, marginKm) {
  return !(a.apogeeKm + marginKm < b.perigeeKm || a.perigeeKm - marginKm > b.apogeeKm);
}

/**
 * Minimise a scalar function on [lo, hi] by golden-section search.
 *
 * Assumes one minimum in the interval, which the coarse scan has already
 * established by bracketing it between a fall and a rise.
 */
function goldenSection(f, lo, hi, toleranceMs) {
  let a = lo;
  let b = hi;
  let c = b - INV_PHI * (b - a);
  let d = a + INV_PHI * (b - a);
  let fc = f(c);
  let fd = f(d);

  while (b - a > toleranceMs) {
    if (fc < fd) {
      b = d; d = c; fd = fc;
      c = b - INV_PHI * (b - a);
      fc = f(c);
    } else {
      a = c; c = d; fc = fd;
      d = a + INV_PHI * (b - a);
      fd = f(d);
    }
  }
  return fc < fd ? c : d;
}

/**
 * Everything worth reporting about one close approach, worked out at the time
 * of closest approach itself rather than carried through from the search.
 */
function describeEvent(target, other, tcaMs) {
  const at = new Date(tcaMs);
  const a = propagateEci(target.satrec, at);
  const b = propagateEci(other.satrec, at);
  if (!a || !b) return null;

  const missKm = rangeKm(a.r, b.r);
  const relSpeedKmS = Math.hypot(a.v.x - b.v.x, a.v.y - b.v.y, a.v.z - b.v.z);

  // Where over the Earth it happens. One extra propagation with the geodetic
  // conversion, once per event rather than once per sample.
  const geo = propagateSat(other.satrec, at);

  return {
    satId: other.id,
    satName: other.name,
    sat: other,
    tcaMs,
    missKm,
    relSpeedKmS,
    // Radial separation on its own, which says whether the pair miss by
    // altitude or by being at different places in the same shell.
    radialKm: Math.abs(Math.hypot(a.r.x, a.r.y, a.r.z) - Math.hypot(b.r.x, b.r.y, b.r.z)),
    lat: geo ? geo.lat : null,
    lon: geo ? geo.lon : null,
    altKm: geo ? geo.altKm : null,
  };
}

/**
 * Screen one object against a set of others over a forward time window.
 *
 * @param {object} options
 * @param {object} options.target the tracked object, with a satrec
 * @param {Array<object>} options.others candidates, each with id, name, satrec
 * @param {Date} options.start window start
 * @param {number} options.windowMs how far ahead to look
 * @param {number} [options.thresholdKm] report approaches inside this
 * @param {number} [options.coarseStepSec] coarse sampling step
 * @param {number} [options.maxEvents] cap on the reported list
 * @param {(fraction: number) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{events: Array, closest: object|null, screened: number,
 *                    skipped: number, propagations: number, elapsedMs: number}>}
 */
export async function screenConjunctions({
  target,
  others,
  start,
  windowMs,
  thresholdKm = 100,
  coarseStepSec = DEFAULT_COARSE_STEP_SEC,
  maxEvents = 20,
  onProgress,
  signal,
}) {
  const began = performance.now();
  const t0 = start.getTime();
  const stepMs = coarseStepSec * 1000;
  const steps = Math.max(2, Math.round(windowMs / stepMs));

  // The target's coarse track, propagated once and shared by every candidate.
  const times = new Array(steps + 1);
  const targetR = new Array(steps + 1);
  for (let i = 0; i <= steps; i += 1) {
    const t = t0 + i * stepMs;
    times[i] = t;
    const pv = propagateEci(target.satrec, new Date(t));
    targetR[i] = pv ? pv.r : null;
  }
  if (!targetR.some(Boolean)) {
    throw new Error('These elements will not propagate over the screening window.');
  }
  let propagations = steps + 1;

  const targetApsis = apsisRadiiKm(target.satrec);
  const margin = thresholdKm + APSIS_MARGIN_KM;

  const candidates = others.filter((o) => o.satrec && o.id !== target.id
    && shellsOverlap(targetApsis, apsisRadiiKm(o.satrec), margin));
  const skipped = others.length - candidates.length;

  const events = [];
  let closest = null;

  const rangeAtMs = (other, ms) => {
    const at = new Date(ms);
    const a = propagateEci(target.satrec, at);
    const b = propagateEci(other.satrec, at);
    propagations += 2;
    return a && b ? rangeKm(a.r, b.r) : Infinity;
  };

  for (let c = 0; c < candidates.length; c += 1) {
    if (signal && signal.aborted) throw new DOMException('Screening cancelled', 'AbortError');

    const other = candidates[c];
    const d = new Array(steps + 1);
    for (let i = 0; i <= steps; i += 1) {
      const pv = targetR[i] ? propagateEci(other.satrec, new Date(times[i])) : null;
      d[i] = pv ? rangeKm(targetR[i], pv.r) : Infinity;
    }
    propagations += steps + 1;

    for (let i = 0; i <= steps; i += 1) {
      // A dip in the sampled range. The ends count too: an approach can be
      // still closing as the window opens, or already the nearest point when
      // it shuts.
      const before = i > 0 ? d[i - 1] : Infinity;
      const after = i < steps ? d[i + 1] : Infinity;
      if (!(d[i] < before && d[i] <= after)) continue;
      if (!Number.isFinite(d[i])) continue;

      const lo = times[Math.max(0, i - 1)];
      const hi = times[Math.min(steps, i + 1)];
      const tca = lo === hi
        ? times[i]
        : goldenSection((ms) => rangeAtMs(other, ms), lo, hi, REFINE_TOLERANCE_MS);

      const event = describeEvent(target, other, tca);
      propagations += 3;
      if (!event) continue;

      if (!closest || event.missKm < closest.missKm) closest = event;
      if (event.missKm <= thresholdKm) events.push(event);
    }

    if (c % CANDIDATES_PER_YIELD === CANDIDATES_PER_YIELD - 1) {
      if (onProgress) onProgress((c + 1) / candidates.length);
      // Hand the frame back so the clock keeps running and the cancel button
      // stays live while a long screening works through the constellation.
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    }
  }

  if (onProgress) onProgress(1);

  // One row per constellation member, not one per crossing.
  //
  // An object at Iridium's altitude meets the same satellite on nearly the same
  // geometry every orbit, so an ungrouped list is twenty rows of one name a few
  // metres apart - true, and useless. What is worth ranking is the closest each
  // pair ever comes; how often that geometry repeats rides alongside it as a
  // count, since a miss that recurs fourteen times in a day is a standing
  // feature of the orbit rather than a single event.
  const byPair = new Map();
  for (const event of events) {
    const held = byPair.get(event.satId);
    if (!held) {
      byPair.set(event.satId, { ...event, encounters: 1 });
    } else {
      held.encounters += 1;
      if (event.missKm < held.missKm) {
        byPair.set(event.satId, { ...event, encounters: held.encounters });
      }
    }
  }

  const ranked = [...byPair.values()].sort((a, b) => a.missKm - b.missKm);

  return {
    events: ranked.slice(0, maxEvents),
    truncated: Math.max(0, ranked.length - maxEvents),
    crossings: events.length,
    closest,
    screened: candidates.length,
    skipped,
    propagations,
    elapsedMs: performance.now() - began,
    thresholdKm,
    windowMs,
    startMs: t0,
  };
}
