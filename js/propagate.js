// Wrappers around satellite.js, which loads from CDN as the global `satellite`.

import { D2R, R2D, EARTH_RADIUS_KM, normLon } from './geo.js';

const MU = 398600.4418; // Earth gravitational parameter, km^3/s^2

/**
 * Parse a CelesTrak TLE file: name line, line 1, line 2, repeating.
 * Records that fail to parse are skipped.
 * @returns {Array<{id: string, name: string, satrec: object, line1: string, line2: string}>}
 */
export function parseTLEs(text) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.length);
  const sats = [];

  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name = lines[i].trim();
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    if (!line1.startsWith('1 ') || !line2.startsWith('2 ')) continue;

    const satrec = satellite.twoline2satrec(line1, line2);
    if (satrec.error) continue;

    sats.push({ id: String(satrec.satnum), name, satrec, line1, line2 });
  }
  return sats;
}

/** Mean altitude from the TLE mean motion, in km. Shown in the detail panel. */
export function meanAltitudeKm(satrec) {
  const nRadPerSec = satrec.no / 60; // satrec.no is radians per minute
  const a = (MU / (nRadPerSec * nRadPerSec)) ** (1 / 3);
  return a - EARTH_RADIUS_KM;
}

/** Orbital period, in minutes. */
export function periodMinutes(satrec) {
  return (2 * Math.PI) / satrec.no;
}

/** Right ascension of the ascending node, degrees in [0, 360). */
export function raanDeg(satrec) {
  return ((satrec.nodeo * R2D) % 360 + 360) % 360;
}

/** TLE epoch as a Date. */
export function epochDate(satrec) {
  const jd = satrec.jdsatepoch + (satrec.jdsatepochF || 0);
  return new Date((jd - 2440587.5) * 86400000);
}

/**
 * Position of a satellite at a given time.
 * @returns {{lat: number, lon: number, altKm: number, speedKmS: number,
 *            eci: object, ecf: object} | null} null if SGP4 did not converge
 */
export function propagateSat(satrec, date) {
  const pv = satellite.propagate(satrec, date);
  if (!pv || !pv.position || !pv.velocity) return null;
  const { position, velocity } = pv;
  if (!Number.isFinite(position.x)) return null;

  const gmst = satellite.gstime(date);
  const geo = satellite.eciToGeodetic(position, gmst);
  const ecf = satellite.eciToEcf(position, gmst);

  return {
    lat: satellite.degreesLat(geo.latitude),
    lon: normLon(satellite.degreesLong(geo.longitude)),
    altKm: geo.height,
    speedKmS: Math.hypot(velocity.x, velocity.y, velocity.z),
    eci: position,
    ecf,
  };
}

/** A ground site in the geodetic form satellite.js look angles expect. */
export function siteGeodetic(site) {
  return {
    longitude: site.lon * D2R,
    latitude: site.lat * D2R,
    height: (site.altKm || 0),
  };
}

/**
 * Look angles from a ground site to a satellite. Takes the satellite's ECF
 * position, not its lat/lon.
 * @returns {{azDeg: number, elDeg: number, rangeKm: number}}
 */
export function lookAngles(siteGd, ecf) {
  const la = satellite.ecfToLookAngles(siteGd, ecf);
  return {
    azDeg: la.azimuth * R2D,
    elDeg: la.elevation * R2D,
    rangeKm: la.rangeSat,
  };
}

/**
 * Argument of latitude: how far round its orbit a satellite is, measured from
 * the ascending node in the direction of travel.
 *
 * Computed from the propagated position, not from the TLE. CelesTrak's Iridium
 * elements are epoched at each satellite's ascending-node crossing, so
 * `argpo + mo` is ~0 for all of them and useless for comparing phasing.
 *
 * @returns {number|null} degrees in [0, 360), or null if it cannot be computed
 */
export function argumentOfLatitude(satrec, date) {
  const pv = satellite.propagate(satrec, date);
  if (!pv || !pv.position || !Number.isFinite(pv.position.x)) return null;

  const { x, y, z } = pv.position;
  const sinI = Math.sin(satrec.inclo);
  if (Math.abs(sinI) < 1e-9) return null; // equatorial orbit: the node is undefined

  const node = satrec.nodeo;
  const alongNode = x * Math.cos(node) + y * Math.sin(node);
  const u = Math.atan2(z / sinI, alongNode) * R2D;
  return (u % 360 + 360) % 360;
}

/**
 * The satellite's path for one orbit either side of `date`.
 *
 * @returns {Array<[number, number, number]>} [lat, lon, altKm] samples. The 2D
 * map uses lat/lon and draws a ground track; the globe uses the altitude too
 * and draws the orbit itself.
 */
export function groundTrack(satrec, date, stepSec = 20) {
  const halfSpanSec = periodMinutes(satrec) * 60;
  const points = [];

  for (let dt = -halfSpanSec; dt <= halfSpanSec; dt += stepSec) {
    const pos = propagateSat(satrec, new Date(date.getTime() + dt * 1000));
    if (pos) points.push([pos.lat, pos.lon, pos.altKm]);
  }
  return points;
}

/**
 * ECI position and velocity only, in km and km/s.
 *
 * Conjunction screening propagates tens of thousands of times per run and
 * needs nothing but the inertial vector, so this skips the gstime call and the
 * geodetic/ECF conversions that make up most of the cost of propagateSat().
 *
 * @returns {{r: {x,y,z}, v: {x,y,z}} | null} null if SGP4 did not converge
 */
export function propagateEci(satrec, date) {
  const pv = satellite.propagate(satrec, date);
  if (!pv || !pv.position || !pv.velocity || !Number.isFinite(pv.position.x)) return null;
  return { r: pv.position, v: pv.velocity };
}

/**
 * Perigee and apogee radii from the mean elements, in km from Earth's centre.
 *
 * Used to throw out pairs whose orbits never reach the same altitude, before
 * anything is propagated. Mean elements, so these are a shell the osculating
 * orbit wanders either side of by a few km - callers add their own margin.
 */
export function apsisRadiiKm(satrec) {
  const nRadPerSec = satrec.no / 60;
  const a = (MU / (nRadPerSec * nRadPerSec)) ** (1 / 3);
  const e = satrec.ecco;
  return { perigeeKm: a * (1 - e), apogeeKm: a * (1 + e), semiMajorKm: a };
}
