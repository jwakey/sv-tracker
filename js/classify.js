// Decides which satellites are operational and which plane each one is in.
//
// Status comes from the roster, and nothing else infers it:
//   1. data/satellite-overrides.json  - manual, per satellite, always wins
//   2. data/constellation-roster.json - operational satellites and spares,
//                                       by plane
//
// A satellite in neither file is treated as operational. Only the roster can
// call something a spare, so a new launch shows up as a normal member of the
// constellation until someone lists it.

import { meanAltitudeKm, raanDeg } from './propagate.js';

// One colour for the whole operational constellation - marks, footprints,
// plane rings and tracks alike. Bright and saturated on purpose: this is the
// green an operations display carries, and the chrome around it is neutral so
// the map can afford it. 12.2:1 against the ocean.
//
// Planes are not coloured apart any more. What still separates them on the map
// is the ring drawn through each plane's satellites, and the legend still
// toggles them one at a time.
export const PLANE_COLOR = '#ffffffd7';
// Spares sit outside that green entirely, in the same amber as their
// visibility lines - which is now the only colour distinction on the map.
// Lighter than the link colour (#c8912f) so the mark still reads where it sits
// on the end of its own line.
export const SPARE_COLOR = '#d9a441';
export const UNASSIGNED_COLOR = '#98a3ac';

const PLANE_GAP_THRESHOLD_DEG = 15;

/** The number in a CelesTrak name: "IRIDIUM 115" -> 115. */
export function vehicleNumber(name) {
  const match = /IRIDIUM\s+(\d+)/i.exec(name || '');
  return match ? Number(match[1]) : null;
}

/** Roster file flattened to vehicle number -> { plane, status }. */
function buildRosterIndex(roster) {
  const index = new Map();
  const planes = (roster && roster.planes) || {};
  for (const [plane, groups] of Object.entries(planes)) {
    for (const v of groups.operational || []) index.set(v, { plane: Number(plane), status: 'operational' });
    for (const v of groups.spares || []) index.set(v, { plane: Number(plane), status: 'spare' });
  }
  return index;
}

/** Smallest signed difference between two angles, in degrees. */
function angularDifference(a, b) {
  return ((a - b + 540) % 360) - 180;
}

/**
 * Tag each satellite with `status` ('operational' | 'spare' | 'hidden'),
 * `statusSource` (what decided it) and `meanAltKm`. Mutates `sats`.
 *
 * `meanAltKm` is carried for the detail panel only; nothing here decides
 * anything from it.
 *
 * @param {Array} sats parsed satellites
 * @param {{overrides?: object}} config
 */
export function classifyStatus(sats, config = {}, roster = null) {
  const overrides = config.overrides || {};
  const rosterIndex = buildRosterIndex(roster);

  for (const sat of sats) {
    sat.meanAltKm = meanAltitudeKm(sat.satrec);
    sat.raan = raanDeg(sat.satrec);
    sat.rosterPlane = null;

    // Space-vehicle designation, as used in ops: IRIDIUM 115 -> SV115.
    sat.vehicle = vehicleNumber(sat.name);
    sat.label = sat.vehicle === null ? sat.name : `SV${sat.vehicle}`;

    // Anything the roster does not mention is assumed to be flying the
    // mission. Only the roster and the overrides file name a spare.
    sat.status = 'operational';
    sat.statusSource = 'unlisted';

    // The roster, where it lists this satellite.
    const listed = rosterIndex.get(sat.vehicle);
    if (listed) {
      sat.status = listed.status;
      sat.statusSource = 'roster';
      sat.rosterPlane = listed.plane;
    }

    // Overrides beat the roster.
    const override = overrides[sat.id];
    if (override === 'operational' || override === 'spare' || override === 'hidden') {
      sat.status = override;
      sat.statusSource = 'override';
    }
  }
  return sats;
}

/** Mean of angles in degrees, taken on the unit circle so 359 and 1 give 0. */
function circularMean(anglesDeg) {
  let x = 0;
  let y = 0;
  for (const a of anglesDeg) {
    x += Math.cos((a * Math.PI) / 180);
    y += Math.sin((a * Math.PI) / 180);
  }
  const mean = (Math.atan2(y, x) * 180) / Math.PI;
  return (mean % 360 + 360) % 360;
}

/**
 * Sort the operational satellites into planes, from the roster if there is one
 * and by clustering RAAN if there is not.
 *
 * Plane centres are recomputed on every TLE refresh, not hardcoded: RAAN
 * precesses. Spares are left unassigned on purpose - they fly lower, so their
 * nodes precess at a different rate and drift off the operational planes.
 *
 * @returns {Array<{index: number, raanCenter: number, color: string, count: number, visible: boolean}>}
 */
export function assignPlanes(sats) {
  for (const sat of sats) {
    sat.plane = sat.rosterPlane || null;
  }

  const rostered = sats.filter((s) => s.rosterPlane);
  const planes = rostered.length ? planesFromRoster(sats) : planesFromRaanClustering(sats);

  // Anything the roster misses - a new launch, say - joins the plane whose
  // node is nearest, so it still gets a colour and a legend entry.
  for (const sat of sats) {
    if (sat.plane || sat.status !== 'operational') continue;
    let nearest = null;
    for (const plane of planes) {
      const delta = Math.abs(angularDifference(sat.raan, plane.raanCenter));
      if (delta <= PLANE_GAP_THRESHOLD_DEG && (!nearest || delta < nearest.delta)) {
        nearest = { plane, delta };
      }
    }
    if (nearest) {
      sat.plane = nearest.plane.index;
      nearest.plane.count += 1;
    }
  }

  return planes;
}

/** Planes built from the roster's own numbering. */
function planesFromRoster(sats) {
  const indices = [...new Set(sats.filter((s) => s.rosterPlane).map((s) => s.rosterPlane))]
    .sort((a, b) => a - b);

  return indices.map((index) => {
    const operational = sats.filter((s) => s.rosterPlane === index && s.status === 'operational');
    const nodes = operational.length
      ? operational.map((s) => s.raan)
      : sats.filter((s) => s.rosterPlane === index).map((s) => s.raan);
    return {
      index,
      raanCenter: circularMean(nodes),
      color: PLANE_COLOR,
      count: operational.length,
      visible: true,
    };
  });
}

/**
 * Planes derived from the elements alone, by clustering right ascension of
 * ascending node. Used when there is no roster.
 */
function planesFromRaanClustering(sats) {
  const operational = sats.filter((s) => s.status === 'operational');
  if (!operational.length) return [];

  const sorted = [...operational].sort((a, b) => a.raan - b.raan);

  const clusters = [];
  let current = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].raan - sorted[i - 1].raan > PLANE_GAP_THRESHOLD_DEG) {
      clusters.push(current);
      current = [];
    }
    current.push(sorted[i]);
  }
  clusters.push(current);

  // First and last clusters may be one plane straddling 0 degrees.
  if (clusters.length > 1) {
    const first = clusters[0];
    const last = clusters[clusters.length - 1];
    if (first[0].raan + 360 - last[last.length - 1].raan <= PLANE_GAP_THRESHOLD_DEG) {
      clusters[0] = last.concat(first);
      clusters.pop();
    }
  }

  return clusters
    .map((members) => ({ members, raanCenter: circularMean(members.map((m) => m.raan)) }))
    .sort((a, b) => a.raanCenter - b.raanCenter)
    .map((cluster, i) => {
      for (const sat of cluster.members) sat.plane = i + 1;
      return {
        index: i + 1,
        raanCenter: cluster.raanCenter,
        color: PLANE_COLOR,
        count: cluster.members.length,
        visible: true,
      };
    });
}

/** Mark colour: plane colour, spare amber, or grey if unassigned. */
export function satColor(sat, planes) {
  if (sat.status === 'spare') return SPARE_COLOR;
  if (sat.plane) {
    const plane = planes.find((p) => p.index === sat.plane);
    if (plane) return plane.color;
  }
  return UNASSIGNED_COLOR;
}
