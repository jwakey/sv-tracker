// Control panel, legend, clock, search and detail panel. All DOM lives here.

import { satColor, SPARE_COLOR } from './classify.js';
import { footprintAngularRadius, EARTH_RADIUS_KM } from './geo.js';
import { periodMinutes, epochDate } from './propagate.js';
import { formatAge } from './tle.js';

const $ = (id) => document.getElementById(id);

/** Format a Date as YYYY-MM-DD HH:MM, in UTC. */
const utcStamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

/**
 * UTC timestamp from parts, rejecting out-of-range values.
 *
 * Date.UTC rolls month 13 into January and 25:00 into tomorrow, so a typo
 * would jump the clock somewhere unasked for. Round-trip the result and
 * reject anything that changed.
 */
function utcFrom(year, month, day, hour, minute, second) {
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const d = new Date(ms);
  const intact = d.getUTCFullYear() === year && d.getUTCMonth() === month - 1
    && d.getUTCDate() === day && d.getUTCHours() === hour
    && d.getUTCMinutes() === minute && d.getUTCSeconds() === second;
  return intact ? ms : null;
}

/**
 * Parse a typed UTC instant. Accepts what the clock prints, pasted ISO, and a
 * bare time of day - the common case, since the reachable window is only a day
 * either side of now.
 *
 *   2026-09-02 01:15:04   2026-09-02T01:15:04Z   2026-09-02 01:15   2026-09-02
 *   01:15:04              01:15
 *
 * @param {string} text
 * @param {Date} reference supplies the date for a bare time of day
 * @returns {number|null} epoch milliseconds, or null if it does not parse
 */
function parseUtcInput(text, reference) {
  const s = text.trim().replace(/\s+/g, ' ');

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?Z?$/i.exec(s);
  if (m) return utcFrom(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));

  m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) {
    return utcFrom(
      reference.getUTCFullYear(), reference.getUTCMonth() + 1, reference.getUTCDate(),
      +m[1], +m[2], +(m[3] || 0),
    );
  }
  return null;
}

// Allowed range for the elevation mask. Keep in step with the min/max on the
// input element: those cover the spinner and browser validation, these cover
// the typed path, where neither applies.
const MASK_MIN_DEG = 0;
const MASK_MAX_DEG = 30;

export function initUI(state, on) {
  const el = {
    summary: $('constellation-summary'),
    tleStatus: $('tle-status'),
    refresh: $('refresh-btn'),
    view2d: $('view-2d'),
    view3d: $('view-3d'),
    displayMenuBtn: $('display-menu-btn'),
    displayMenu: $('display-dropdown'),
    simTime: $('sim-time'),
    simDate: $('sim-date'),
    offsetTag: $('time-offset'),
    play: $('play-btn'),
    now: $('now-btn'),
    speed: $('speed-select'),
    slider: $('time-slider'),
    jumpInput: $('jump-input'),
    jumpBtn: $('jump-btn'),
    jumpHint: $('jump-hint'),
    offsetReadout: $('offset-readout'),
    optOperational: $('opt-operational'),
    optSpares: $('opt-spares'),
    optHighlightSpares: $('opt-highlight-spares'),
    optFootprints: $('opt-footprints'),
    optVisLines: $('opt-vislines'),
    optPlaneLinks: $('opt-planelinks'),
    optSatNames: $('opt-satnames'),
    optDayNight: $('opt-daynight'),
    maskInput: $('mask-input'),
    footprintReadout: $('footprint-readout'),
    footprintOpacity: $('footprint-opacity'),
    footprintOpacityReadout: $('footprint-opacity-readout'),
    legend: $('plane-legend'),
    search: $('sat-search'),
    searchResults: $('search-results'),
    detail: $('detail-panel'),
    detailBody: $('detail-body'),
    detailClose: $('detail-close'),
    loading: $('loading'),
  };

  el.refresh.addEventListener('click', () => on.refresh());
  el.view2d.addEventListener('click', () => on.setView('2d'));
  el.view3d.addEventListener('click', () => on.setView('3d'));

  function closeDisplayMenu() {
    el.displayMenu.hidden = true;
    el.displayMenuBtn.setAttribute('aria-expanded', 'false');
  }

  el.displayMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = el.displayMenu.hidden;
    el.displayMenu.hidden = !opening;
    el.displayMenuBtn.setAttribute('aria-expanded', String(opening));
  });

  // Click-outside and Escape close the menu. Clicks inside it - checkboxes,
  // the legend - must not, so those stop propagation before reaching here.
  document.addEventListener('click', (e) => {
    if (!el.displayMenu.hidden
      && !el.displayMenu.contains(e.target) && !el.displayMenuBtn.contains(e.target)) {
      closeDisplayMenu();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.displayMenu.hidden) closeDisplayMenu();
  });

  el.play.addEventListener('click', () => on.togglePlay());
  el.now.addEventListener('click', () => on.resetTime());
  el.speed.addEventListener('change', () => on.setRate(Number(el.speed.value)));
  el.slider.addEventListener('input', () => on.setOffsetMinutes(Number(el.slider.value)));

  // ------------------------------------------------------------ jump to UTC

  // The hint doubles as the error line, so keep its resting text to restore.
  // It carries markup, hence innerHTML.
  const jumpHintHtml = el.jumpHint.innerHTML;
  const setJumpHint = (message) => {
    if (message) el.jumpHint.textContent = message;
    else el.jumpHint.innerHTML = jumpHintHtml;
    el.jumpHint.classList.toggle('bad', Boolean(message));
  };

  function jump() {
    const raw = el.jumpInput.value;
    if (!raw.trim()) { setJumpHint(null); return; }

    const ms = parseUtcInput(raw, state.time.current);
    if (ms === null) {
      setJumpHint('Not a time. Use YYYY-MM-DD HH:MM:SS, or HH:MM on its own.');
      return;
    }

    // Reach comes off the scrubber element, so typing and dragging cannot
    // drift apart. Out-of-range is refused, not clamped: better to say why
    // nothing happened than to land somewhere unasked for.
    const reachMs = Number(el.slider.max) * 60000;
    const now = Date.now();
    if (Math.abs(ms - now) > reachMs) {
      setJumpHint(`Out of reach. ${utcStamp(now - reachMs)} to ${utcStamp(now + reachMs)} UTC.`);
      return;
    }

    setJumpHint(null);
    on.setTime(ms);
  }

  el.jumpBtn.addEventListener('click', jump);
  el.jumpInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); jump(); }
    else if (e.key === 'Escape') { el.jumpInput.value = ''; setJumpHint(null); el.jumpInput.blur(); }
  });
  el.jumpInput.addEventListener('input', () => {
    if (el.jumpHint.classList.contains('bad')) setJumpHint(null);
  });

  el.detailClose.addEventListener('click', () => on.clearSelection());

  let matches = [];
  let activeIndex = 0;

  el.search.addEventListener('input', () => { activeIndex = 0; renderSearch(); });

  el.search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!matches.length) return;
      e.preventDefault();
      activeIndex = (activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
      renderSearch();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (matches[activeIndex]) chooseResult(matches[activeIndex].id);
    } else if (e.key === 'Escape') {
      el.search.value = '';
      el.search.blur();
      renderSearch();
    }
  });

  // "/" focuses the search box from anywhere, unless already typing.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    e.preventDefault();
    el.search.focus();
    el.search.select();
  });

  function chooseResult(id) {
    el.search.value = '';
    matches = [];
    activeIndex = 0;
    renderSearch();
    on.selectSat(id);
  }

  el.optOperational.addEventListener('change', () => on.setOpt('showOperational', el.optOperational.checked));
  el.optSpares.addEventListener('change', () => on.setOpt('showSpares', el.optSpares.checked));
  el.optHighlightSpares.addEventListener('change', () => on.setOpt('highlightSpares', el.optHighlightSpares.checked));
  el.optFootprints.addEventListener('change', () => on.setOpt('showFootprints', el.optFootprints.checked));
  el.optVisLines.addEventListener('change', () => on.setOpt('showVisLines', el.optVisLines.checked));
  el.optDayNight.addEventListener('change', () => on.setOpt('dayNight', el.optDayNight.checked));
  el.optPlaneLinks.addEventListener('change', () => on.setOpt('showPlaneLinks', el.optPlaneLinks.checked));
  el.optSatNames.addEventListener('change', () => on.setOpt('showSatNames', el.optSatNames.checked));

  // The mask is typed, so it has to cope with half-finished entries. 'input'
  // takes anything already valid, so the map follows as digits land; 'change'
  // (blur or Enter) clamps and writes back, rather than fighting the caret.
  el.maskInput.addEventListener('input', () => {
    const value = Number(el.maskInput.value);
    if (el.maskInput.value.trim() === '' || !Number.isFinite(value)) return;
    if (value < MASK_MIN_DEG || value > MASK_MAX_DEG) return;
    on.setOpt('maskDeg', value);
  });
  el.maskInput.addEventListener('change', () => {
    const value = Number(el.maskInput.value);
    const settled = Number.isFinite(value) && el.maskInput.value.trim() !== ''
      ? Math.min(MASK_MAX_DEG, Math.max(MASK_MIN_DEG, value))
      : state.opts.maskDeg;
    const rounded = Number(settled.toFixed(1));
    el.maskInput.value = String(rounded);
    on.setOpt('maskDeg', rounded);
  });

  el.footprintOpacity.addEventListener('input', () => {
    on.setOpt('footprintOpacity', Number(el.footprintOpacity.value) / 100);
  });

  function setLoading(visible, message) {
    el.loading.classList.toggle('hidden', !visible);
    if (message) el.loading.innerHTML = `<span class="spinner"></span><span>${escapeHtml(message)}</span>`;
  }

  function showError(message) {
    el.loading.classList.remove('hidden');
    el.loading.innerHTML = `<p class="error-note">${escapeHtml(message)}</p>`;
  }

  function setActiveView(kind) {
    el.view2d.classList.toggle('active', kind === '2d');
    el.view3d.classList.toggle('active', kind === '3d');
    el.view2d.setAttribute('aria-pressed', String(kind === '2d'));
    el.view3d.setAttribute('aria-pressed', String(kind === '3d'));
  }

  /**
   * Rank satellites against the query. An exact vehicle number ranks first, so
   * "115" finds IRIDIUM 115 ahead of every name containing those digits.
   */
  function searchMatches(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    const scored = [];
    for (const sat of state.sats) {
      if (sat.status === 'hidden') continue; // suppressed by an override
      const name = sat.name.toLowerCase();
      const vehicle = (/iridium\s+(\d+)/i.exec(sat.name) || [])[1] || '';

      let score = null;
      if (vehicle && vehicle === q) score = 0;
      else if (vehicle && vehicle.startsWith(q)) score = 1;
      else if (sat.id.startsWith(q)) score = 2;
      else if (name.includes(q)) score = 3;
      if (score !== null) scored.push({ sat, score });
    }

    return scored
      .sort((a, b) => (a.score - b.score) || a.sat.name.localeCompare(b.sat.name, undefined, { numeric: true }))
      .slice(0, 8)
      .map((m) => m.sat);
  }

  function renderSearch() {
    matches = searchMatches(el.search.value);
    el.searchResults.innerHTML = '';

    if (!el.search.value.trim()) return;

    if (!matches.length) {
      const empty = document.createElement('li');
      empty.className = 'search-empty';
      empty.textContent = 'No satellite matches that.';
      el.searchResults.appendChild(empty);
      return;
    }

    matches.forEach((sat, i) => {
      const row = document.createElement('li');
      row.className = i === activeIndex ? 'active' : '';
      row.setAttribute('role', 'option');
      row.innerHTML = `
        <span class="swatch" style="background:${satColor(sat, state.planes)}"></span>
        <span class="result-name">${escapeHtml(sat.name)}</span>
        <span class="result-meta ${sat.status}">${sat.status === 'spare' ? 'spare' : `plane ${sat.plane || '?'}`}</span>`;
      row.addEventListener('mouseenter', () => { activeIndex = i; renderSearch(); });
      row.addEventListener('click', () => chooseResult(sat.id));
      el.searchResults.appendChild(row);
    });
  }

  function renderStatus() {
    const operational = state.sats.filter((s) => s.status === 'operational').length;
    const spares = state.sats.filter((s) => s.status === 'spare').length;
    el.summary.textContent = `${operational} operational · ${spares} spare · ${state.planes.length} planes`;

    const label = state.tle.source === 'network' ? 'live'
      : state.tle.source === 'cache' ? 'cached' : 'snapshot';
    el.tleStatus.textContent = `elements: ${label}, ${formatAge(state.tle.fetchedAt)}`;
    el.tleStatus.classList.toggle('stale', state.tle.source === 'snapshot');
  }

  function renderClock() {
    // Time and date are separate elements: the clock is read at a glance and
    // the date is context, so they are sized apart in the stylesheet.
    const iso = state.time.current.toISOString();
    el.simTime.textContent = iso.slice(11, 19);
    el.simDate.textContent = iso.slice(0, 10);

    const offsetMin = Math.round((state.time.current.getTime() - Date.now()) / 60000);
    const shifted = Math.abs(offsetMin) >= 1;
    el.offsetTag.textContent = shifted ? formatOffset(offsetMin) : 'Live';
    el.offsetTag.classList.toggle('shifted', shifted);
    el.offsetReadout.textContent = shifted ? formatOffset(offsetMin) : 'now';
    if (document.activeElement !== el.slider) {
      el.slider.value = String(Math.max(-1440, Math.min(1440, offsetMin)));
    }
    el.play.textContent = state.time.playing ? 'Pause' : 'Play';
    el.play.setAttribute('aria-pressed', String(state.time.playing));
  }

  function renderOptions() {
    // Not while it has focus: rewriting the value under the caret would undo
    // a partial entry like "1" on the way to "12".
    if (document.activeElement !== el.maskInput) {
      el.maskInput.value = String(Number(state.opts.maskDeg.toFixed(1)));
    }
    const gamma = footprintAngularRadius(777.7, state.opts.maskDeg);
    el.footprintReadout.textContent = `${Math.round(gamma * EARTH_RADIUS_KM).toLocaleString()} km`;
    el.footprintOpacityReadout.textContent = `${Math.round(state.opts.footprintOpacity * 100)}%`;
  }

  function renderLegend() {
    el.legend.innerHTML = '';

    for (const plane of state.planes) {
      const row = document.createElement('label');
      row.className = `legend-row${plane.visible ? '' : ' off'}`;
      row.innerHTML = `
        <input type="checkbox" ${plane.visible ? 'checked' : ''}>
        <span class="swatch" style="background:${plane.color}"></span>
        <span class="legend-name">Plane ${plane.index}</span>
        <span class="legend-meta">${plane.count} &middot; ${plane.raanCenter.toFixed(0)}°</span>`;
      row.querySelector('input').addEventListener('change', (e) => {
        on.setPlaneVisible(plane.index, e.target.checked);
      });
      el.legend.appendChild(row);
    }

    const spares = state.sats.filter((s) => s.status === 'spare').length;
    const spareRow = document.createElement('label');
    spareRow.className = `legend-row${state.opts.showSpares ? '' : ' off'}`;
    spareRow.innerHTML = `
      <input type="checkbox" ${state.opts.showSpares ? 'checked' : ''}>
      <span class="swatch" style="background:${SPARE_COLOR}"></span>
      <span class="legend-name">Spares</span>
      <span class="legend-meta">${spares} &middot; parked</span>`;
    spareRow.querySelector('input').addEventListener('change', (e) => {
      el.optSpares.checked = e.target.checked;
      on.setOpt('showSpares', e.target.checked);
    });
    el.legend.appendChild(spareRow);
  }

  function syncOptionInputs() {
    el.optSpares.checked = state.opts.showSpares;
    el.optHighlightSpares.checked = state.opts.highlightSpares;
    el.optOperational.checked = state.opts.showOperational;
    el.optFootprints.checked = state.opts.showFootprints;
    el.optVisLines.checked = state.opts.showVisLines;
    el.optDayNight.checked = state.opts.dayNight;
    el.optPlaneLinks.checked = state.opts.showPlaneLinks;
    el.optSatNames.checked = state.opts.showSatNames;
    el.footprintOpacity.value = String(Math.round(state.opts.footprintOpacity * 100));
  }

  function renderDetail() {
    if (state.selectedSatId) {
      const sat = state.sats.find((s) => s.id === state.selectedSatId);
      if (sat) {
        el.detail.hidden = false;
        el.detailBody.innerHTML = satelliteDetail(sat, state);
        return;
      }
    }
    if (state.selectedSiteName) {
      const site = state.sites.find((s) => s.name === state.selectedSiteName);
      if (site) {
        el.detail.hidden = false;
        el.detailBody.innerHTML = siteDetail(site, state);
        return;
      }
    }
    el.detail.hidden = true;
    el.detailBody.innerHTML = '';
  }

  return {
    setLoading, showError, setActiveView, renderStatus, renderClock,
    renderOptions, renderLegend, renderDetail, syncOptionInputs, renderSearch,
  };
}

function satelliteDetail(sat, state) {
  const pos = state.positions.get(sat.id);
  const color = satColor(sat, state.planes);
  const ageDays = (state.time.current - epochDate(sat.satrec)) / 86400000;

  const seenBy = [];
  for (const [siteName, entries] of state.visibility) {
    const hit = entries.find((e) => e.sat.id === sat.id);
    if (hit) seenBy.push({ siteName, ...hit });
  }
  seenBy.sort((a, b) => b.elDeg - a.elDeg);

  const rows = [
    ['NORAD ID', sat.id],
    ['Status', sat.status === 'spare' ? 'In-orbit spare' : 'Operational'],
    ['Classified by', {
      override: 'manual override',
      roster: 'constellation roster',
    }[sat.statusSource] || 'not in roster'],
    ['Plane', sat.plane ? `${sat.plane} (RAAN ${sat.raan.toFixed(1)}°)` : `unassigned (RAAN ${sat.raan.toFixed(1)}°)`],
    ['Latitude', pos ? `${pos.lat.toFixed(3)}°` : '—'],
    ['Longitude', pos ? `${pos.lon.toFixed(3)}°` : '—'],
    ['Altitude', pos ? `${pos.altKm.toFixed(1)} km` : '—'],
    ['Speed', pos ? `${pos.speedKmS.toFixed(3)} km/s` : '—'],
    ['Footprint radius', pos ? `${Math.round(pos.gammaRad * EARTH_RADIUS_KM).toLocaleString()} km` : '—'],
    ['Inclination', `${(sat.satrec.inclo * 180 / Math.PI).toFixed(3)}°`],
    ['Period', `${periodMinutes(sat.satrec).toFixed(2)} min`],
    ['Mean altitude', `${sat.meanAltKm.toFixed(1)} km`],
    ['Element age', `${ageDays.toFixed(2)} days`],
  ];

  return `
    <h3><span class="swatch" style="background:${color}"></span>${escapeHtml(sat.name)}</h3>
    <span class="badge ${sat.status}">${sat.status === 'spare' ? 'Spare' : 'Operational'}</span>
    <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('')}</dl>
    <h4>In view from</h4>
    ${seenBy.length
      ? `<ul class="vis-list">${seenBy.map((s) => `
          <li><span>${escapeHtml(s.siteName)}</span><span class="el">${s.elDeg.toFixed(1)}° el &middot; ${Math.round(s.rangeKm)} km</span></li>`).join('')}</ul>`
      : '<p class="vis-list empty-note">No ground site currently has this satellite above its horizon mask.</p>'}
    ${ageDays > 7 ? '<p class="note">These elements are over a week old; positions will have drifted. Refresh to re-fetch from CelesTrak.</p>' : ''}`;
}

function siteDetail(site, state) {
  const entries = state.visibility.get(site.name) || [];
  const spares = entries.filter((e) => e.sat.status === 'spare');

  const rows = [
    ['Latitude', `${site.lat.toFixed(4)}°`],
    ['Longitude', `${site.lon.toFixed(4)}°`],
    ['Elevation mask', `${site.elevationMaskDeg}°`],
    ['Satellites in view', String(entries.length)],
    ['Spares in view', String(spares.length)],
  ];

  return `
    <h3>${escapeHtml(site.name)}</h3>
    <span class="badge site">Ground site</span>
    <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>
    ${site.notes ? `<p class="note" style="margin-bottom:16px">${escapeHtml(site.notes)}</p>` : ''}
    <h4>Above the horizon now</h4>
    ${entries.length
      ? `<ul class="vis-list">${entries.slice(0, 20).map((e) => `
          <li><span><span class="swatch" style="background:${satColor(e.sat, state.planes)}"></span>${escapeHtml(e.sat.name)}</span><span class="el">${e.elDeg.toFixed(1)}° el</span></li>`).join('')}</ul>`
      : '<p class="vis-list empty-note">Nothing above the mask right now.</p>'}
    <p class="note">Coordinates are approximate published station locations. Edit <code>data/ground-sites.json</code> to change them.</p>`;
}

function formatOffset(minutes) {
  const sign = minutes < 0 ? '−' : '+';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return h ? `${sign}${h}h ${m}m` : `${sign}${m}m`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
