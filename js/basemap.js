// The basemap: coastline data, and the equirectangular raster the globe wraps
// itself in.
//
// The 2D map draws land straight onto its canvas, culling and projecting as it
// pans. The globe cannot do that, so it asks for the same polygons rasterised a
// tile at a time, in the same palette. Both views therefore show the same
// coastlines in the same colours, from the same file.

import { MAP_COLORS } from './palette.js';

/**
 * Land polygons as [{bbox, rings}], each ring a flat lon/lat array. The box
 * covers the whole polygon, holes included, since the rings fill together as
 * one even-odd path.
 */
export async function loadLand() {
  try {
    const res = await fetch('data/ne_110m_land.geojson');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const geo = await res.json();

    const polygons = [];
    const addPolygon = (coords) => {
      let minLat = Infinity; let maxLat = -Infinity;
      let minLon = Infinity; let maxLon = -Infinity;
      const rings = coords.map((ring) => {
        const flat = new Float64Array(ring.length * 2);
        for (let i = 0; i < ring.length; i += 1) {
          const [lon, lat] = ring[i];
          flat[i * 2] = lon;
          flat[i * 2 + 1] = lat;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
        }
        return flat;
      });
      polygons.push({ rings, bbox: { minLat, maxLat, minLon, maxLon } });
    };

    for (const feature of geo.features) {
      const g = feature.geometry;
      if (!g) continue;
      if (g.type === 'Polygon') addPolygon(g.coordinates);
      else if (g.type === 'MultiPolygon') g.coordinates.forEach(addPolygon);
    }
    return polygons;
  } catch (err) {
    console.warn('Coastline data unavailable, continuing without a basemap:', err);
    return [];
  }
}

/**
 * One tile of the basemap: ocean, land, coastlines, graticule, drawn for an
 * arbitrary lat/lon rectangle.
 *
 * The globe asks for these as it needs them, at whatever level of detail the
 * camera is at, which is what keeps coastlines crisp when zoomed in - a single
 * whole-Earth texture is soft at every zoom past the first. Drawing is cheap:
 * polygons outside the rectangle are rejected on their bounding box.
 *
 * @param {Array} polygons from loadLand()
 * @param {{west: number, south: number, east: number, north: number,
 *          width: number, height: number}} tile rectangle in degrees, size in px
 * @returns {HTMLCanvasElement}
 */
export function renderBasemapTile(polygons, {
  west = -180, south = -90, east = 180, north = 90, width = 512, height = 512,
} = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  const x = (lon) => ((lon - west) / (east - west)) * width;
  const y = (lat) => ((north - lat) / (north - south)) * height;

  ctx.fillStyle = MAP_COLORS.ocean;
  ctx.fillRect(0, 0, width, height);

  // Line weights are in tile pixels, not degrees. Cesium picks the tile level
  // whose resolution matches the screen, so a constant here is a constant on
  // screen - the coastline does not thicken as you zoom in.
  ctx.fillStyle = MAP_COLORS.land;
  ctx.strokeStyle = MAP_COLORS.coast;
  ctx.lineWidth = 1.3;
  ctx.lineJoin = 'round';
  for (const polygon of polygons) {
    const b = polygon.bbox;
    if (b.maxLon < west || b.minLon > east || b.maxLat < south || b.minLat > north) continue;
    ctx.beginPath();
    for (const ring of polygon.rings) {
      for (let i = 0; i < ring.length; i += 2) {
        const px = x(ring[i]);
        const py = y(ring[i + 1]);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
    }
    ctx.fill('evenodd');
    ctx.stroke();
  }

  // Graticule, every 30 degrees, plus a brighter equator - the same lines the
  // 2D map draws.
  ctx.lineWidth = 0.9;
  ctx.strokeStyle = MAP_COLORS.graticule;
  ctx.beginPath();
  for (let lon = -180; lon <= 180; lon += 30) {
    if (lon < west || lon > east) continue;
    ctx.moveTo(x(lon), 0);
    ctx.lineTo(x(lon), height);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    if (lat === 0 || lat < south || lat > north) continue;
    ctx.moveTo(0, y(lat));
    ctx.lineTo(width, y(lat));
  }
  ctx.stroke();

  if (south <= 0 && north >= 0) {
    ctx.beginPath();
    ctx.strokeStyle = MAP_COLORS.equator;
    ctx.lineWidth = 1.4;
    ctx.moveTo(0, y(0));
    ctx.lineTo(width, y(0));
    ctx.stroke();
  }

  return canvas;
}
