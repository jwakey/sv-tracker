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

const TICK_MS = 200;
const MAX_OFFSET_MS = 24 * 60 * 60 * 1000;

// How far ahead the direction arrow looks. Only the bearing is used, so this
// just has to be long enough for the two points to differ cleanly.
const LEAD_SEC = 90;

const state = {
  sats: [],
  planes: [],
  sites: [],
  positions: new Map(),
  visibility: new Map(), // site name -> [{sat, elDeg, rangeKm}], best pass first
  visLinks: [],
  planeRings: [],
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

  /** Whether the display filters currently allow this satellite. */
  isVisible(sat) {
    if (sat.status === 'hidden') return false;
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
    return this.opts.highlightSpares && sat.status === 'spare' && this.isVisible(sat);
  },
};

const views = { '2d': null, '3d': null };
let activeView = null;
let ui;
let lastFrameMs = performance.now();

const handlers = {
  onSelectSat: (id) => { state.selectedSatId = id; state.selectedSiteName = null; refreshDerived(); },
  onSelectSite: (name) => { state.selectedSiteName = name; state.selectedSatId = null; refreshDerived(); },
  onClearSelection: () => { state.selectedSatId = null; state.selectedSiteName = null; refreshDerived(); },
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

  state.sats = sats;
  state.planes = planes;
  state.sites = sites;
  state.tle = { fetchedAt: tle.fetchedAt, source: tle.source };
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

/** Recompute and repaint now, outside the regular tick. */
function refreshDerived() {
  computePositions(state.time.current);
  computePlaneRings(state.time.current);
  computeTrack(state.time.current);
  if (activeView) activeView.render(state);
  ui.renderDetail();
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
    selectSat: (id) => {
      const sat = state.sats.find((s) => s.id === id);
      if (!sat) return;
      revealSat(sat);
      state.selectedSatId = id;
      state.selectedSiteName = null;
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
