// Application state, the per-tick work, and the animation loop.

import { loadTLEs } from './tle.js';
import {
  parseTLEs, propagateSat, groundTrack, siteGeodetic, lookAngles, argumentOfLatitude,
} from './propagate.js';
import { classifyStatus, assignPlanes, satColor } from './classify.js';
import { footprintAngularRadius } from './geo.js';
import { create2DView } from './view2d.js';
import { create3DView } from './view3d.js';
import { initUI } from './ui.js';
import { searchCatalog, toTracked, fetchByCatalogNumber } from './catalog.js';
import { screenConjunctions } from './conjunction.js';

const TICK_MS = 200;
const MAX_OFFSET_MS = 24 * 60 * 60 * 1000;

// How far ahead the direction arrow looks. Only the bearing is used, so this
// just has to be long enough for the two points to differ cleanly.
const LEAD_SEC = 90;

// A screening window has to end inside the reach of the scrubber, or a result
// could name a time the display cannot be taken to. A minute of slack absorbs
// the wall-clock drift between running the screening and clicking the result.
const MAX_SCREEN_WINDOW_MS = MAX_OFFSET_MS - 60 * 1000;

const state = {
  // sats is the drawing set and is derived: the constellation, then whatever
  // has been added from the catalogue. Everything downstream - both views, the
  // per-tick propagation, picking - reads this one array and does not care
  // which half a satellite came from. syncSatList() rebuilds it.
  sats: [],
  iridium: [],
  tracked: [],
  planes: [],
  sites: [],
  positions: new Map(),
  visibility: new Map(), // site name -> [{sat, elDeg, rangeKm}], best pass first
  visLinks: [],
  planeRings: [],
  // Tracked object id -> the constellation member it is nearest right now.
  // Recomputed every tick from positions already in hand, so the detail panel
  // has a live range without a screening run behind it.
  trackedNearest: new Map(),
  // Satellites picked out without being selected - both halves of a
  // conjunction, so the pair reads as a pair while the clock sits at the time
  // of closest approach.
  highlightIds: new Set(),
  track: null,
  trackColor: '#dfe4e8',
  selectedSatId: null,
  selectedSiteName: null,
  tle: { fetchedAt: null, source: null },
  opts: {
    showOperational: true,
    showSpares: true,
    showFootprints: true,
    showVisLines: true,
    showPlaneLinks: true,
    showSatNames: true,
    highlightSpares: false,
    dayNight: true,
    maskDeg: 8.2,
    // Fraction of full strength, not an alpha. Each view scales it to its own
    // maximum, so 0.3 looks the same on the map and the globe.
    footprintOpacity: 0.3,
  },
  time: { simMs: Date.now(), rate: 1, playing: true, current: new Date() },

  screening: {
    running: false,
    progress: 0,
    targetId: null,      // which tracked object the result belongs to
    result: null,
    error: null,
    windowHours: 12,
    thresholdKm: 100,
  },

  /** Whether the display filters currently allow this satellite. */
  isVisible(sat) {
    if (sat.status === 'hidden') return false;
    // Tracked objects answer to no display filter. They are on the map because
    // someone put them there, and the constellation's filters have nothing to
    // say about an object outside the constellation.
    if (sat.tracked) return true;
    if (sat.status === 'spare') return this.opts.showSpares;
    if (!this.opts.showOperational) return false;
    if (!sat.plane) return true;
    const plane = this.planes.find((p) => p.index === sat.plane);
    return !plane || plane.visible;
  },

  /**
   * Whether a satellite is picked out: footprint at full strength, a ring on
   * the mark, and a direction arrow.
   *
   * Both views ask this, so "highlight all spares" and a single selection
   * share one visual state instead of two. The orbit track is not part of it:
   * that stays on the selection alone, since 14 at once buries the map.
   */
  isHighlighted(sat) {
    if (this.selectedSatId === sat.id) return true;
    if (this.highlightIds.has(sat.id)) return true;
    // Always, for a tracked object: it is one violet dot among eighty, and the
    // ring and direction arrow are what make it findable. It carries no
    // footprint, so this costs nothing on the map.
    if (sat.tracked) return true;
    return this.opts.highlightSpares && sat.status === 'spare' && this.isVisible(sat);
  },
};

/** Rebuild the drawing set from the constellation and the tracked objects. */
function syncSatList() {
  state.sats = state.iridium.concat(state.tracked);
}

const views = { '2d': null, '3d': null };
let activeView = null;
let ui;
let lastFrameMs = performance.now();

// Picking anything by hand ends the conjunction pairing: the two rings meant
// "these two are about to pass", and that is no longer what the display shows.
const handlers = {
  onSelectSat: (id) => {
    state.selectedSatId = id; state.selectedSiteName = null;
    state.highlightIds.clear(); refreshDerived();
  },
  onSelectSite: (name) => {
    state.selectedSiteName = name; state.selectedSatId = null;
    state.highlightIds.clear(); refreshDerived();
  },
  onClearSelection: () => {
    state.selectedSatId = null; state.selectedSiteName = null;
    state.highlightIds.clear(); refreshDerived();
  },
};

// ---------------------------------------------------------------- data load

async function loadConstellation({ force = false } = {}) {
  const [tle, sites, overrides, roster] = await Promise.all([
    loadTLEs({ force }),
    fetchJSON('data/ground-sites.json', []),
    fetchJSON('data/satellite-overrides.json', {}),
    fetchJSON('data/constellation-roster.json', null),
  ]);

  const sats = parseTLEs(tle.text);
  if (!sats.length) throw new Error('No usable orbital elements were returned.');

  classifyStatus(sats, overrides, roster);
  const planes = assignPlanes(sats);

  state.iridium = sats;
  state.planes = planes;
  state.sites = sites;
  state.tle = { fetchedAt: tle.fetchedAt, source: tle.source };
  syncSatList();
}

/**
 * Re-fetch the elements for every tracked object.
 *
 * Runs with the constellation refresh, because a screening is only as current
 * as its stalest half: refreshing the Iridium elements and leaving a week-old
 * catalogue object in place would quietly make the miss distances worse, not
 * better. One query per object, and anything that fails keeps what it has.
 */
async function refreshTracked() {
  if (!state.tracked.length) return;

  await Promise.all(state.tracked.map(async (obj) => {
    try {
      const fresh = await fetchByCatalogNumber(obj.id);
      if (!fresh) return;
      Object.assign(obj, toTracked(fresh));
    } catch (err) {
      console.warn(`Could not refresh elements for ${obj.name}:`, err);
    }
  }));
  syncSatList();
}

async function fetchJSON(url, fallback) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`Could not load ${url}, using defaults:`, err);
    return fallback;
  }
}

// ------------------------------------------------------------ per-tick work

/** Propagate every satellite, then rebuild visibility and the spare links. */
function computePositions(date) {
  state.positions.clear();
  for (const sat of state.sats) {
    const pos = propagateSat(sat.satrec, date);
    if (!pos) continue;
    pos.gammaRad = footprintAngularRadius(pos.altKm, state.opts.maskDeg);
    // Where it will be shortly, for the direction arrow. One extra SGP4 call
    // per highlighted satellite.
    if (state.isHighlighted(sat)) {
      const ahead = propagateSat(sat.satrec, new Date(date.getTime() + LEAD_SEC * 1000));
      if (ahead) pos.ahead = { lat: ahead.lat, lon: ahead.lon, altKm: ahead.altKm };
    }
    state.positions.set(sat.id, pos);
  }

  state.visibility.clear();
  state.visLinks = [];

  for (const site of state.sites) {
    const gd = siteGeodetic(site);
    const mask = site.elevationMaskDeg ?? 5;
    const entries = [];

    for (const sat of state.sats) {
      // Ground-site visibility is a constellation question - which Iridium can
      // this station work - so a tracked object passing overhead does not
      // belong in the list even though it is on the map.
      if (sat.tracked) continue;
      const pos = state.positions.get(sat.id);
      if (!pos || !state.isVisible(sat)) continue;
      const look = lookAngles(gd, pos.ecf);

      // Links are for spares only, and only while the site is inside the
      // drawn footprint. That means the user's mask, not the site's own:
      // the site mask would draw links to satellites outside the very disc
      // meant to show their reach.
      if (sat.status === 'spare' && look.elDeg >= state.opts.maskDeg) {
        state.visLinks.push({ site, sat, pos });
      }

      if (look.elDeg < mask) continue;
      entries.push({ sat, elDeg: look.elDeg, rangeKm: look.rangeKm });
    }

    entries.sort((a, b) => b.elDeg - a.elDeg);
    state.visibility.set(site.name, entries);
  }

  computeTrackedNearest();
}

/**
 * For each tracked object, the constellation member it is closest to right now.
 *
 * Straight from the inertial positions the tick has already computed, so it is
 * 66-odd distance calculations per tracked object and no propagation at all.
 * This is the live half of the feature: scrub the clock and the range updates
 * under you. The screening below is the other half, and finds the minima this
 * would only stumble on.
 */
function computeTrackedNearest() {
  state.trackedNearest.clear();
  if (!state.tracked.length) return;

  for (const obj of state.tracked) {
    const a = state.positions.get(obj.id);
    if (!a) continue;

    let best = null;
    for (const sat of state.iridium) {
      if (sat.status === 'hidden') continue;
      const b = state.positions.get(sat.id);
      if (!b) continue;
      const d = Math.hypot(a.eci.x - b.eci.x, a.eci.y - b.eci.y, a.eci.z - b.eci.z);
      if (!best || d < best.rangeKm) best = { sat, rangeKm: d };
    }
    if (best) state.trackedNearest.set(obj.id, best);
  }
}

/**
 * Order each plane's satellites around their orbit so they can be joined up.
 *
 * At any instant a plane's satellites all lie on the great circle where the
 * orbital plane cuts the Earth, so joining them in order traces that circle.
 *
 * Points are [lat, lon, altKm]. The map uses lat/lon and draws along the
 * ground track; the globe uses the altitude and runs the line through the
 * satellites themselves.
 */
function computePlaneRings(date) {
  state.planeRings = [];
  if (!state.opts.showPlaneLinks) return;

  for (const plane of state.planes) {
    if (!plane.visible || !state.opts.showOperational) continue;

    const members = [];
    for (const sat of state.sats) {
      if (sat.plane !== plane.index || sat.status !== 'operational') continue;
      const pos = state.positions.get(sat.id);
      if (!pos) continue;
      const u = argumentOfLatitude(sat.satrec, date);
      if (u === null) continue;
      members.push({ u, point: [pos.lat, pos.lon, pos.altKm] });
    }
    if (members.length < 3) continue;

    members.sort((a, b) => a.u - b.u);
    state.planeRings.push({
      index: plane.index,
      color: plane.color,
      points: members.map((m) => m.point),
    });
  }
}

/** Orbit track for the selected satellite, or null if nothing is selected. */
function computeTrack(date) {
  const sat = state.selectedSatId && state.sats.find((s) => s.id === state.selectedSatId);
  if (!sat) {
    state.track = null;
    return;
  }
  state.track = groundTrack(sat.satrec, date, 20);
  state.trackColor = satColor(sat, state.planes);
}

function tick() {
  const nowMs = performance.now();
  const elapsed = nowMs - lastFrameMs;
  lastFrameMs = nowMs;

  if (state.time.playing) {
    state.time.simMs += elapsed * state.time.rate;
  }
  clampOffset();

  state.time.current = new Date(state.time.simMs);
  computePositions(state.time.current);
  computePlaneRings(state.time.current);
  computeTrack(state.time.current);

  if (activeView) activeView.render(state);
  ui.renderClock();
  ui.renderDetail();
}

/** Clamp simulated time to the +-24 h the scrubber covers. */
function clampOffset() {
  const realNow = Date.now();
  const offset = state.time.simMs - realNow;
  if (offset > MAX_OFFSET_MS) state.time.simMs = realNow + MAX_OFFSET_MS;
  if (offset < -MAX_OFFSET_MS) state.time.simMs = realNow - MAX_OFFSET_MS;
}

/** Repaint from the geometry already computed. No propagation. */
function redraw() {
  if (activeView) activeView.render(state);
}

/**
 * Recompute and repaint now, outside the regular tick.
 *
 * Everything that changes the selection or the tracked set settles here, so the
 * sidebar's tracked list and screening panel are rebuilt here too - otherwise
 * clicking a tracked mark on the map would select it without the panel that
 * screens it noticing. Both are a few rows of DOM and only run on discrete
 * interactions, never on the 5 Hz tick.
 */
function refreshDerived() {
  computePositions(state.time.current);
  computePlaneRings(state.time.current);
  computeTrack(state.time.current);
  if (activeView) activeView.render(state);
  ui.renderDetail();
  ui.renderTracked();
  ui.renderScreening();
}

/**
 * Turn off whatever filter is hiding a satellite, so selecting a search result
 * always shows something.
 */
function revealSat(sat) {
  let changed = false;

  if (sat.status === 'spare' && !state.opts.showSpares) {
    state.opts.showSpares = true;
    changed = true;
  }
  if (sat.status === 'operational' && !state.opts.showOperational) {
    state.opts.showOperational = true;
    changed = true;
  }

  const plane = state.planes.find((p) => p.index === sat.plane);
  if (plane && !plane.visible) {
    plane.visible = true;
    changed = true;
  }

  if (changed) {
    ui.syncOptionInputs();
    ui.renderLegend();
  }
}

// ------------------------------------------------------- conjunction screening

let screenAbort = null;

function clearScreening() {
  state.screening.result = null;
  state.screening.error = null;
  state.screening.targetId = null;
  state.screening.progress = 0;
}

/**
 * Screen one tracked object against the constellation and hand the result to
 * the panel.
 *
 * The window is capped to what the scrubber can reach, so every time of closest
 * approach the panel offers is a time the display can actually be taken to.
 * Screening starts from real now rather than simulated time: a result that
 * moved every time the clock was scrubbed would be unreadable.
 */
async function runScreening(targetId) {
  const target = state.tracked.find((s) => s.id === targetId);
  if (!target || state.screening.running) return;

  if (screenAbort) screenAbort.abort();
  screenAbort = new AbortController();

  clearScreening();
  state.screening.running = true;
  state.screening.targetId = targetId;
  ui.renderScreening();

  const windowMs = Math.min(state.screening.windowHours * 3600 * 1000, MAX_SCREEN_WINDOW_MS);

  try {
    const result = await screenConjunctions({
      target,
      others: state.iridium.filter((s) => s.status !== 'hidden'),
      start: new Date(),
      windowMs,
      thresholdKm: state.screening.thresholdKm,
      signal: screenAbort.signal,
      onProgress: (fraction) => {
        state.screening.progress = fraction;
        ui.renderScreening();
      },
    });
    state.screening.result = result;
  } catch (err) {
    if (err.name === 'AbortError') {
      clearScreening();
    } else {
      console.error(err);
      state.screening.error = err.message;
    }
  } finally {
    state.screening.running = false;
    screenAbort = null;
    ui.renderScreening();
    ui.renderDetail();
  }
}

// -------------------------------------------------------------- view switch

async function setView(kind) {
  if (activeView && activeView.kind === kind) return;

  document.getElementById('map-2d').classList.toggle('hidden', kind !== '2d');
  document.getElementById('map-3d').classList.toggle('hidden', kind !== '3d');
  ui.setActiveView(kind);

  if (!views[kind]) {
    if (kind === '3d') {
      ui.setLoading(true, 'Loading 3D globe…');
      try {
        views['3d'] = await create3DView(document.getElementById('map-3d'), handlers);
      } catch (err) {
        console.error(err);
        ui.setLoading(false);
        ui.setActiveView('2d');
        document.getElementById('map-2d').classList.remove('hidden');
        document.getElementById('map-3d').classList.add('hidden');
        alert('The 3D globe could not be loaded. Check your connection and try again.');
        return;
      }
      ui.setLoading(false);
    } else {
      views['2d'] = create2DView(document.getElementById('map-2d'), handlers);
    }
  }

  activeView = views[kind];
  activeView.invalidateSize();
  activeView.render(state);
}

// -------------------------------------------------------------------- start

async function main() {
  ui = initUI(state, {
    refresh: async () => {
      ui.setLoading(true, 'Fetching latest elements…');
      try {
        await loadConstellation({ force: true });
        await refreshTracked();
        ui.renderStatus();
        ui.renderLegend();
        refreshDerived();
      } catch (err) {
        console.error(err);
      }
      ui.setLoading(false);
    },
    setView,
    togglePlay: () => { state.time.playing = !state.time.playing; ui.renderClock(); },
    resetTime: () => { state.time.simMs = Date.now(); refreshDerived(); ui.renderClock(); },
    setRate: (rate) => { state.time.rate = rate; },
    setTime: (ms) => {
      state.time.simMs = ms;
      state.time.current = new Date(ms);
      refreshDerived();
      ui.renderClock();
    },
    setOffsetMinutes: (minutes) => {
      state.time.simMs = Date.now() + minutes * 60000;
      state.time.current = new Date(state.time.simMs);
      refreshDerived();
      ui.renderClock();
    },
    setOpt: (key, value) => {
      state.opts[key] = value;
      ui.renderOptions();
      // Only the spares row lives in the legend, so this is the only key that
      // needs it rebuilt. Doing it for every option would churn the DOM.
      if (key === 'showSpares') {
        ui.renderLegend();
        ui.syncOptionInputs();
      }
      // Opacity moves nothing, and arrives continuously while the slider is
      // dragged, so it repaints instead of propagating all 80 satellites.
      if (key === 'footprintOpacity') redraw();
      else refreshDerived();
    },
    setPlaneVisible: (index, visible) => {
      const plane = state.planes.find((p) => p.index === index);
      if (plane) plane.visible = visible;
      ui.renderLegend();
      refreshDerived();
    },
    clearSelection: handlers.onClearSelection,

    // ------------------------------------------------- catalogue and screening

    searchCatalog: (query, options) => searchCatalog(query, options),

    /** Put a catalogue object on the map, and select it. */
    addTracked: (record) => {
      if (state.sats.some((s) => s.id === record.id)) return { ok: false, reason: 'already' };

      const obj = toTracked(record);
      state.tracked.push(obj);
      syncSatList();

      state.selectedSatId = obj.id;
      state.selectedSiteName = null;
      state.highlightIds.clear();
      refreshDerived();
      if (activeView) activeView.focusSat(state.positions.get(obj.id));
      return { ok: true, sat: obj };
    },

    removeTracked: (id) => {
      state.tracked = state.tracked.filter((s) => s.id !== id);
      syncSatList();
      state.highlightIds.delete(id);
      if (state.selectedSatId === id) state.selectedSatId = null;
      // A result set belongs to the object it was run against, so it goes with
      // it rather than being left to look like it describes something else.
      if (state.screening.targetId === id) clearScreening();
      refreshDerived();
    },

    setScreenOpt: (key, value) => {
      state.screening[key] = value;
      // The result was computed under the old window or threshold, so it is no
      // longer an answer to the question the panel is now asking.
      clearScreening();
      ui.renderScreening();
    },

    runScreening: (targetId) => runScreening(targetId),
    cancelScreening: () => { if (screenAbort) screenAbort.abort(); },

    /**
     * Take the display to a close approach: the clock to the moment itself,
     * both objects picked out, and the constellation member selected so its
     * detail panel is up.
     */
    gotoConjunction: (event) => {
      const target = state.tracked.find((s) => s.id === state.screening.targetId);
      state.highlightIds = new Set(target ? [target.id, event.satId] : [event.satId]);
      state.selectedSatId = event.satId;
      state.selectedSiteName = null;
      state.time.playing = false;
      state.time.simMs = event.tcaMs;
      state.time.current = new Date(event.tcaMs);
      refreshDerived();
      ui.renderClock();
      if (activeView) activeView.focusSat(state.positions.get(event.satId));
    },

    selectSat: (id) => {
      const sat = state.sats.find((s) => s.id === id);
      if (!sat) return;
      revealSat(sat);
      state.selectedSatId = id;
      state.selectedSiteName = null;
      state.highlightIds.clear();
      refreshDerived();
      if (activeView) activeView.focusSat(state.positions.get(id));
    },
  });

  ui.setLoading(true, 'Loading orbital elements…');

  try {
    await loadConstellation();
  } catch (err) {
    console.error(err);
    ui.showError(`Could not load orbital elements. ${err.message}`);
    return;
  }

  ui.renderStatus();
  ui.renderOptions();
  ui.renderLegend();
  await setView('2d');
  ui.setLoading(false);

  lastFrameMs = performance.now();
  tick();
  setInterval(tick, TICK_MS);
  setInterval(ui.renderStatus, 60000);

  // For poking at live state from the browser console.
  window.iridium = { state, views, get view() { return activeView; } };
}

main();
