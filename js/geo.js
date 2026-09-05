// Spherical geometry for the 2D map: geodesic circles, antimeridian splitting
// and pole closure. Near-polar orbits break all three, so they live together.

export const EARTH_RADIUS_KM = 6378.137;
export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

/**
 * Point at a bearing and angular distance from a start point.
 * @param {number} latDeg
 * @param {number} lonDeg
 * @param {number} bearingDeg
 * @param {number} angRad distance along the great circle, in radians
 * @returns {[number, number]} [lat, lon] in degrees; lon is NOT normalised
 */
export function destination(latDeg, lonDeg, bearingDeg, angRad) {
  const lat1 = latDeg * D2R;
  const lon1 = lonDeg * D2R;
  const brg = bearingDeg * D2R;
  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAng = Math.sin(angRad);
  const cosAng = Math.cos(angRad);

  const sinLat2 = sinLat1 * cosAng + cosLat1 * sinAng * Math.cos(brg);
  const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat2)));
  const lon2 = lon1 + Math.atan2(
    Math.sin(brg) * sinAng * cosLat1,
    cosAng - sinLat1 * sinLat2,
  );
  return [lat2 * R2D, lon2 * R2D];
}

/** Wrap a longitude into [-180, 180). */
export function normLon(lon) {
  let l = (lon + 180) % 360;
  if (l < 0) l += 360;
  return l - 180;
}

/**
 * The point with the sun directly overhead.
 *
 * Low-precision solar position from the Astronomical Almanac: good to ~0.01
 * degrees for a century either side of J2000, far finer than a 1 px
 * terminator needs. Declination tilts the terminator off the meridian; the
 * longitude is local noon and includes the equation of time.
 *
 * @param {Date} date
 * @returns {{lat: number, lon: number}} subsolar point in degrees
 */
export function subsolarPoint(date) {
  // Days since J2000.0. 2440587.5 is the Julian date of the Unix epoch.
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;

  const meanLon = 280.460 + 0.9856474 * n;
  const meanAnomaly = (357.528 + 0.9856003 * n) * D2R;
  const eclipticLon = (meanLon
    + 1.915 * Math.sin(meanAnomaly)
    + 0.020 * Math.sin(2 * meanAnomaly)) * D2R;
  const obliquity = (23.439 - 0.0000004 * n) * D2R;

  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLon));
  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLon),
    Math.cos(eclipticLon),
  );
  // Greenwich mean sidereal time, in degrees.
  const gmst = 280.46061837 + 360.98564736629 * n;

  return { lat: declination * R2D, lon: normLon(rightAscension * R2D - gmst) };
}

/**
 * Angular radius of a satellite's ground footprint.
 *
 *   gamma = acos( (Re / (Re + h)) * cos(eps) ) - eps
 *
 * @param {number} altKm altitude above the surface
 * @param {number} maskDeg elevation mask at the ground
 * @returns {number} central angle in radians; 0 if nothing is in view
 */
export function footprintAngularRadius(altKm, maskDeg) {
  const eps = maskDeg * D2R;
  const ratio = (EARTH_RADIUS_KM / (EARTH_RADIUS_KM + altKm)) * Math.cos(eps);
  if (ratio >= 1) return 0;
  return Math.acos(ratio) - eps;
}

/**
 * Longitudes rewritten so the sequence is continuous, with no +-360 jumps.
 * Returns a new array; the input is not touched.
 */
function unwrap(points) {
  const out = [points[0].slice()];
  for (let i = 1; i < points.length; i += 1) {
    const prevLon = out[i - 1][1];
    let lon = points[i][1];
    while (lon - prevLon > 180) lon -= 360;
    while (lon - prevLon < -180) lon += 360;
    out.push([points[i][0], lon]);
  }
  return out;
}

/**
 * Copies of a ring at -360/0/+360 degrees of longitude, keeping only the ones
 * that fall inside the [-180, 180] map. Draws seam-straddling rings on both
 * edges without any polygon clipping.
 */
function visibleShifts(ring) {
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const [, lon] of ring) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  const rings = [];
  for (const shift of [-360, 0, 360]) {
    if (minLon + shift <= 180 && maxLon + shift >= -180) {
      rings.push(shift === 0 ? ring : ring.map(([lat, lon]) => [lat, lon + shift]));
    }
  }
  return rings;
}

/**
 * Footprint as one or more polygon rings, ready to draw.
 *
 * Two cases break a naive circle:
 *  - straddles the antimeridian: emit shifted copies
 *  - contains a pole: close the ring along the map edge, or it draws as a
 *    torn band across the map
 *
 * @returns {Array<Array<[number, number]>>} rings of [lat, lon]
 */
export function footprintRings(latDeg, lonDeg, gammaRad) {
  if (gammaRad <= 0) return [];

  const containsNorth = (90 - latDeg) * D2R < gammaRad;
  const containsSouth = (90 + latDeg) * D2R < gammaRad;
  const overPole = containsNorth || containsSouth;

  // Near a pole a small bearing step swings longitude a long way, so sample
  // finely enough that unwrap() can still tell which way the ring is going.
  const steps = overPole ? 160 : 64;

  // Sample bearing 360 as well as 0. Stopping one step short leaves the arc
  // between the last sample and the first undrawn, which over a pole is a
  // wedge of longitude the footprint never covers - a gap running from the
  // edge of the disc up to the pole.
  const raw = [];
  for (let i = 0; i <= steps; i += 1) {
    raw.push(destination(latDeg, lonDeg, (i * 360) / steps, gammaRad));
  }

  const ring = unwrap(raw);

  if (overPole) {
    // A disc over a pole unwraps into a band a full turn wide, and the region
    // it covers is everything between that band and the pole. Walk out to the
    // pole edge and back to close it; both walls land on the same meridian, a
    // map width apart, so neither shows inside the visible window.
    const poleLat = containsNorth ? 90 : -90;
    const firstLon = ring[0][1];
    const lastLon = ring[ring.length - 1][1];
    ring.push([poleLat, lastLon], [poleLat, firstLon]);
  }

  return visibleShifts(ring);
}

/**
 * The footprint's true boundary, as polylines ready to stroke.
 *
 * footprintRings() closes a pole-covering disc by walking out to the pole and
 * back, which is right for filling and wrong for stroking: those walls are an
 * artefact of the projection, not an edge of the footprint, and drawing them
 * puts a line from the disc to the pole and another along the top of the map.
 *
 * @returns {Array<Array<[number, number]>>} polylines of [lat, lon]
 */
export function footprintOutline(latDeg, lonDeg, gammaRad) {
  if (gammaRad <= 0) return [];

  const overPole = (90 - latDeg) * D2R < gammaRad || (90 + latDeg) * D2R < gammaRad;
  const steps = overPole ? 160 : 64;

  const raw = [];
  for (let i = 0; i <= steps; i += 1) {
    raw.push(destination(latDeg, lonDeg, (i * 360) / steps, gammaRad));
  }

  // unwrap first so the walk is continuous, then bring every point back into
  // the map window and cut it wherever it crosses the seam.
  const ring = unwrap(raw).map(([lat, lon]) => [lat, normLon(lon)]);
  return splitAtAntimeridian(ring);
}

/**
 * Split a path at the antimeridian, adding the crossing point at +-180 so the
 * segments meet the map edge with no gap.
 *
 * Extra components past [lat, lon] -- altitude, position along the path -- are
 * interpolated at the crossing and kept.
 *
 * @param {Array<Array<number>>} points [lat, lon, ...extras], lon in [-180, 180]
 * @returns {Array<Array<Array<number>>>}
 */
export function splitAtAntimeridian(points) {
  if (points.length < 2) return points.length ? [points] : [];

  const segments = [];
  let current = [points[0].slice()];

  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const point = points[i];
    const delta = point[1] - prev[1];

    if (Math.abs(delta) > 180) {
      // Crossed the seam: interpolate at the crossing and cap both sides at
      // the map edge.
      const goingEast = delta < 0; // e.g. 179 -> -179
      const prevEdge = goingEast ? 180 : -180;
      const nextEdge = goingEast ? -180 : 180;
      const adjusted = goingEast ? point[1] + 360 : point[1] - 360;
      const t = (prevEdge - prev[1]) / (adjusted - prev[1]);

      // Longitude is pinned to the edge; everything else is interpolated.
      const atEdge = (edgeLon) => prev.map(
        (value, k) => (k === 1 ? edgeLon : value + (point[k] - value) * t),
      );

      current.push(atEdge(prevEdge));
      segments.push(current);
      current = [atEdge(nextEdge), point.slice()];
    } else {
      current.push(point.slice());
    }
  }

  segments.push(current);
  return segments.filter((s) => s.length > 1);
}

/**
 * Great-circle arc between two points, sampled as [lat, lon] with normalised
 * longitudes. Run it through splitAtAntimeridian() before drawing.
 */
/**
 * Angle subtended at Earth's centre by two surface points, in radians.
 *
 * The haversine form, so it keeps its precision for the very short separations
 * a close approach produces - the plain cosine rule loses most of its
 * significant figures below a degree or so.
 */
export function angularSeparation(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R;
  const p2 = lat2 * D2R;
  return 2 * Math.asin(Math.min(1, Math.sqrt(
    Math.sin((p2 - p1) / 2) ** 2
    + Math.cos(p1) * Math.cos(p2) * Math.sin(((lon2 - lon1) * D2R) / 2) ** 2,
  )));
}

/** The point halfway along the great circle between two points. */
export function greatCircleMidpoint(lat1, lon1, lat2, lon2) {
  return greatCircleArc(lat1, lon1, lat2, lon2, 2)[1];
}

export function greatCircleArc(lat1, lon1, lat2, lon2, steps = 48) {
  const p1 = [lat1 * D2R, lon1 * D2R];
  const p2 = [lat2 * D2R, lon2 * D2R];
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((p2[0] - p1[0]) / 2) ** 2
    + Math.cos(p1[0]) * Math.cos(p2[0]) * Math.sin((p2[1] - p1[1]) / 2) ** 2,
  ));

  if (!Number.isFinite(d) || d < 1e-9) return [[lat1, normLon(lon1)], [lat2, normLon(lon2)]];

  const pts = [];
  for (let i = 0; i <= steps; i += 1) {
    const f = i / steps;
    const a = Math.sin((1 - f) * d) / Math.sin(d);
    const b = Math.sin(f * d) / Math.sin(d);
    const x = a * Math.cos(p1[0]) * Math.cos(p1[1]) + b * Math.cos(p2[0]) * Math.cos(p2[1]);
    const y = a * Math.cos(p1[0]) * Math.sin(p1[1]) + b * Math.cos(p2[0]) * Math.sin(p2[1]);
    const z = a * Math.sin(p1[0]) + b * Math.sin(p2[0]);
    pts.push([Math.atan2(z, Math.sqrt(x * x + y * y)) * R2D, Math.atan2(y, x) * R2D]);
  }
  return pts;
}
