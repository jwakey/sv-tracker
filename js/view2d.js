// 2D equirectangular map, on Leaflet with EPSG:4326.
//
// Not Web Mercator: it stops at ~85 degrees, and Iridium's 86.4 degree
// inclination takes the constellation over both poles.
//
// Drawing follows Leaflet's own L.Canvas renderer. Stacked canvases sit in the
// overlay pane, ride the map pane's transform through a drag or zoom, and
// repaint once when the gesture ends. They are drawn larger than the viewport
// so a short drag never exposes an undrawn edge.
//
// Separate canvases because the halves change for different reasons:
//
//  - the basemap (ocean, land, graticule) changes only with the view, so the
//    5 Hz data tick skips it;
//  - the constellation changes five times a second and shares one canvas, so
//    draw order is painter's order. Leaflet's vector layers could not do this:
//    dots ended up buried under footprints created later.
//
// EPSG:4326 makes lat/lon to pixel linear, so projecting a point is a multiply
// and an add rather than a Leaflet call, and anything whose bounding box misses
// the canvas is dropped before it becomes a path.

import {
  footprintRings, footprintOutline, splitAtAntimeridian, greatCircleArc,
  greatCircleMidpoint, angularSeparation, subsolarPoint, D2R, R2D,
} from './geo.js';
import { CLOSE_APPROACH_KM } from './conjunction.js';
import { satColor } from './classify.js';
import { MAP_COLORS as COLORS } from './palette.js';
import { loadLand } from './basemap.js';
import {
  markScale, markRadius, drawMark, labelSize, labelOffsetAcross,
  SAT_KNOCKOUT_PX, SAT_R_OPERATIONAL, SAT_R_SPARE, SAT_R_SELECTED,
  LABEL_GAP_PX, LABEL_FAMILY, LABEL_OUTLINE,
  HEADING_GAP_PX, HEADING_LEN_PX, HEADING_HALF_PX,
} from './symbology.js';

const WORLD_BOUNDS = [[-90, -180], [90, 180]];
// Floor for the click/hover target. Marks grow with the zoom and the target
// grows with them, but never below this.
const HIT_RADIUS_PX = 9;

// Extra canvas drawn past the viewport, per side. Matches L.Renderer's
// default: enough that ordinary drags stay inside the painted area, and no
// more, since repaint cost is fill-rate bound on the footprint discs and
// scales with canvas area. A drag that outruns it repaints once per frame.
const PAD = 0.1;

// Uplink pulse: one sweep from ground site to satellite per period. SIGMA is
// the width of the bright crest, as a fraction of the whole line.
const PULSE_PERIOD_MS = 1100;
const PULSE_SIGMA = 0.1;

// Labels hang to the right of the mark, so a satellite just off the canvas can
// still owe a label. Keep drawing marks this far past the edge.
const DOT_MARGIN_PX = 90;

// Alpha at footprint opacity 1.0. Dozens of discs overlap, so the useful range
// is all at the bottom - past this, coastlines stop reading through a stack of
// them. The default 0.3 gives the 0.045 and 0.2 these used to be fixed at.
const FOOTPRINT_ALPHA_MAX = 0.15;
const FOOTPRINT_SELECTED_ALPHA_MAX = 2 / 3;

// Wheel zoom. PX_PER_LEVEL is the trackpad travel for one zoom level, TAU_MS
// how fast the map catches up to where the wheel asked for. The easing is for
// notched mice, which arrive as one jump per detent; trackpad deltas are small
// enough to track the fingers either way. EPSILON stops the loop.
const ZOOM_PX_PER_LEVEL = 180;
const ZOOM_TAU_MS = 90;
const ZOOM_EPSILON = 0.002;

// A mac trackpad pinch arrives as a wheel event with ctrlKey set and much
// smaller deltas than a scroll, so it needs its own gain to cover the same
// range in one gesture.
const ZOOM_PINCH_GAIN = 4;

// For wheel events that report deltas in lines or pages instead of pixels.
// A line is roughly one text line; a page is the pane.
const WHEEL_LINE_PX = 16;

// Longitude sampling for the terminator. Finer than the curve needs while it
// is shallow, but it keeps it clean at an equinox, where the curve stands up
// and crosses the map in a couple of steps.
const TERMINATOR_STEP_DEG = 1;

// Framing for a conjunction. The pair are placed to span this fraction of the
// shorter side of the pane: enough that they are unmistakably two marks with a
// line between them, not so much that the line runs out of the window and the
// label has nowhere to sit.
const PAIR_SPAN_FRACTION = 0.3;
// Never zoom out to frame a pair. A wide miss is better shown tight and off the
// edge than by pulling back to a view where neither mark is legible.
const PAIR_MIN_ZOOM = 4;

// Range line and its label.
const PAIR_LINE_WIDTH = 1.6;
const PAIR_DASH = [5, 4];
// Clearance the range box keeps from the line it measures. Not the whole
// offset: labelOffsetAcross() adds the box's own half-size on each axis, so
// this is the gap that actually shows.
const PAIR_LABEL_GAP_PX = 8;

export function create2DView(container, handlers = {}) {
  const map = L.map(container, {
    crs: L.CRS.EPSG4326,
    center: [15, 0],
    zoom: 1,
    minZoom: 0,
    // Raised from 7 for conjunction framing. A close approach is tens of
    // kilometres, and at zoom 7 a 5 km separation is eight pixels - the two
    // marks land on top of each other and there is nothing to look at. There is
    // no tile pyramid to run out of here: the basemap is Natural Earth vectors
    // drawn on canvas, so the extra levels cost nothing but coarser coastlines,
    // and the marks stop growing at zoom 6.8 anyway (MARK_SCALE_MAX).
    maxZoom: 11,
    worldCopyJump: false,
    maxBounds: WORLD_BOUNDS,
    // Soft rubber-band. Higher fights zoom-to-cursor near the edges, where the
    // constraint yanks the view back mid-gesture.
    maxBoundsViscosity: 0,
    attributionControl: false,
    zoomControl: true,
    // Fractional zoom, so the "world fits the pane" level is reachable even
    // though it falls between integers, and so the wheel can move a fraction
    // of a level per frame - see wheelZoom().
    zoomSnap: 0,
    zoomDelta: 1,
    // Replaced wholesale by wheelZoom() below.
    scrollWheelZoom: false,
  });

  L.control.attribution({ prefix: false })
    .addAttribution('Coastlines: Natural Earth &middot; Orbits: CelesTrak')
    .addTo(map);

  // sitePane sits above the base overlay pane (ocean/land/footprints/pulses),
  // same as Leaflet's default markerPane would - ground sites read over the
  // map. markPane sits above that in turn, holding only the satellite marks
  // and their labels, so a satellite passing over a ground site still draws
  // (and labels) on top of it rather than being buried under the site icon.
  map.createPane('sitePane');
  map.getPane('sitePane').style.zIndex = 450;
  map.createPane('markPane');
  map.getPane('markPane').style.zIndex = 500;

  const siteLayer = L.layerGroup().addTo(map);
  const siteMarkers = new Map();

  let landPolygons = [];
  let state = null;
  let frame = null;   // geometry for this instant, reused across repaints
  let hoverSatId = null;

  const layer = new ConstellationLayer(drawBase, drawOverlay, drawLinkPulses, drawMarks).addTo(map);

  // Runs only while there is something to animate, and stops itself.
  let pulseRequest = null;
  const animatePulses = () => {
    pulseRequest = null;
    if (!state || !state.opts.showVisLines || !state.visLinks.length) return;
    layer.renderPulse();
    pulseRequest = requestAnimationFrame(animatePulses);
  };
  const ensurePulseLoop = () => {
    if (pulseRequest !== null) return;
    if (!state || !state.opts.showVisLines || !state.visLinks.length) return;
    pulseRequest = requestAnimationFrame(animatePulses);
  };

  loadLand().then((polys) => { landPolygons = polys; layer.redrawAll(); });
  fitWorld(map, container, layer);
  const stopWheelZoom = wheelZoom(map, container);

  // ---------------------------------------------------------------- picking

  function satelliteAt(containerPoint) {
    if (!frame) return null;
    // buildFrame() already dropped everything the filters hide, so the dots
    // are exactly the pickable set. No need to re-test visibility here.
    const proj = projector(map);
    const p = map.containerPointToLayerPoint(containerPoint);
    const scale = markScale(map.getZoom());
    let best = null;
    for (const dot of frame.dots) {
      const dx = proj.x(dot.lon) - p.x;
      const dy = proj.y(dot.lat) - p.y;
      const d2 = dx * dx + dy * dy;
      const reach = Math.max(HIT_RADIUS_PX, (dot.spare ? SAT_R_SPARE : SAT_R_OPERATIONAL) * scale + SAT_KNOCKOUT_PX * scale + 2);
      if (d2 <= reach * reach && (!best || d2 < best.d2)) best = { id: dot.id, d2 };
    }
    return best && best.id;
  }

  map.on('click', (e) => {
    const id = satelliteAt(e.containerPoint);
    if (id) {
      if (handlers.onSelectSat) handlers.onSelectSat(id);
    } else if (handlers.onClearSelection) {
      handlers.onClearSelection();
    }
  });

  map.on('mousemove', (e) => {
    const id = satelliteAt(e.containerPoint);
    if (id !== hoverSatId) {
      hoverSatId = id;
      L.DomUtil[id ? 'addClass' : 'removeClass'](map.getContainer(), 'sat-hover');
      layer.redraw();
    }
  });

  map.on('mouseout', () => {
    if (hoverSatId) { hoverSatId = null; layer.redraw(); }
  });

  // ---------------------------------------------------------------- drawing

  /**
   * Turn the current state into ready-to-draw geometry.
   *
   * Arcs and footprint rings are a lot of trigonometry, and none of it depends
   * on zoom or pan. Doing it once per data change instead of once per repaint
   * is what keeps dragging and zooming cheap.
   *
   * Every path gets a lat/lon bounding box here too, so drawing can reject it
   * without walking its points.
   */
  function buildFrame(st) {
    const footprints = [];
    const dots = [];

    for (const sat of st.sats) {
      const pos = st.positions.get(sat.id);
      if (!pos || !st.isVisible(sat)) continue;

      const selected = st.selectedSatId === sat.id;
      const highlighted = st.isHighlighted(sat);
      const color = satColor(sat, st.planes);

      // noFootprint is set on catalogue objects: the coverage disc is a comms
      // figure and they are not comms assets, and one drawn at an arbitrary
      // altitude can cover a hemisphere.
      if ((st.opts.showFootprints || highlighted) && !sat.noFootprint) {
        const rings = footprintRings(pos.lat, pos.lon, pos.gammaRad).map(boundPath);
        // Only a highlighted footprint is stroked, so only it needs the real
        // boundary worked out separately from the filled rings.
        const outline = highlighted
          ? footprintOutline(pos.lat, pos.lon, pos.gammaRad).map(boundPath)
          : null;
        footprints.push({ rings, outline, color, highlighted });
      }
      dots.push({
        id: sat.id, lat: pos.lat, lon: pos.lon, color, selected, highlighted,
        ahead: highlighted ? pos.ahead : null,
        spare: sat.status === 'spare', label: sat.label,
      });
    }

    const planePaths = [];
    if (st.opts.showPlaneLinks) {
      for (const ring of st.planeRings) {
        const segments = [];
        for (let i = 0; i < ring.points.length; i += 1) {
          const a = ring.points[i];
          const b = ring.points[(i + 1) % ring.points.length];
          segments.push(...splitAtAntimeridian(greatCircleArc(a[0], a[1], b[0], b[1], 16)));
        }
        planePaths.push({ color: ring.color, segments: segments.map(boundPath) });
      }
    }

    const linkSegments = [];
    if (st.opts.showVisLines) {
      for (const link of st.visLinks) {
        // Arc runs site -> satellite, so the third component is 0 at the
        // ground and 1 at the spare. The pulse rides it that way: uplink.
        const arc = greatCircleArc(link.site.lat, link.site.lon, link.pos.lat, link.pos.lon, 24);
        const withPosition = arc.map((point, i) => [point[0], point[1], i / (arc.length - 1)]);
        linkSegments.push(...splitAtAntimeridian(withPosition));
      }
    }

    const trackPaths = (st.tracks || [])
      .map((t) => ({ color: t.color, segments: splitAtAntimeridian(t.points).map(boundPath) }))
      .filter((t) => t.segments.length);

    return {
      footprints,
      dots,
      planePaths,
      linkSegments: linkSegments.map(boundPath),
      trackPaths,
      showNames: st.opts.showSatNames,
      pair: buildPair(st),
    };
  }

  /**
   * The two ends of the active conjunction, as a path on the ground.
   *
   * A great-circle arc rather than a straight line between the two pixels: near
   * a pole - which is where Iridium approaches happen - two satellites twenty
   * kilometres apart can sit a hundred and eighty degrees of longitude apart on
   * an equirectangular map. Drawn straight, the line would cross the entire
   * world the wrong way round. The arc goes over the pole, which is where the
   * pair actually are.
   */
  function buildPair(st) {
    const pair = st.conjunction;
    if (!pair) return null;
    const a = st.positions.get(pair.aId);
    const b = st.positions.get(pair.bId);
    if (!a || !b || pair.rangeKm === null || pair.rangeKm === undefined) return null;

    const arc = greatCircleArc(a.lat, a.lon, b.lat, b.lon, 24);
    return {
      segments: splitAtAntimeridian(arc).map(boundPath),
      mid: greatCircleMidpoint(a.lat, a.lon, b.lat, b.lon),
      a: [a.lat, a.lon],
      b: [b.lat, b.lon],
      rangeKm: pair.rangeKm,
      close: pair.rangeKm < CLOSE_APPROACH_KM,
    };
  }

  /** Basemap: everything that changes with the view but not with the data. */
  function drawBase(view) {
    const { ctx, proj } = view;
    clipToWorld(ctx, proj);
    drawOcean(ctx, proj);
    drawLand(view);
    drawGraticule(ctx, proj);
    ctx.restore();
  }

  /** Constellation: everything that changes with simulated time. */
  function drawOverlay(view) {
    if (!state || !frame) return;
    const { ctx, proj } = view;

    clipToWorld(ctx, proj);
    // Under everything else - it is lighting, not data.
    if (state.opts.dayNight) drawDayNight(view);
    drawFootprints(view, frame);
    drawPlaneRings(view, frame);
    drawGroundTrack(view, frame);
    drawVisibilityLines(view, frame);
    ctx.restore();
  }

  /**
   * The satellite marks and their labels, on their own canvas above the
   * ground-site pane - so a satellite passing over a site still draws (and
   * names itself) on top of it, rather than being buried under the site's own
   * icon and label.
   */
  function drawMarks(view) {
    if (!state || !frame) return;
    const { ctx, proj } = view;

    clipToWorld(ctx, proj);
    // Under the marks, over everything else: the line joins two satellites, so
    // it must not be buried by a footprint, and must not cover the very marks
    // it is joining. Its label goes on last, over both.
    drawPairLine(view, frame);
    drawSatellites(view, frame);
    drawSatLabels(view, frame);
    drawPairLabel(view, frame);
    ctx.restore();

    drawHoverLabel(view, frame);
  }

  /**
   * Clip to the world rectangle. Seam-straddling footprints are drawn as copies
   * shifted +-360 degrees, and this stops them spilling into the letterbox
   * area. Leaves the context saved: the caller restores.
   */
  function clipToWorld(ctx, proj) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(proj.x(-180), proj.y(90), proj.x(180) - proj.x(-180), proj.y(-90) - proj.y(90));
    ctx.clip();
  }

  function drawOcean(ctx, proj) {
    ctx.fillStyle = COLORS.ocean;
    ctx.fillRect(proj.x(-180), proj.y(90), proj.x(180) - proj.x(-180), proj.y(-90) - proj.y(90));
  }

  function drawLand(view) {
    const { ctx, proj } = view;
    ctx.fillStyle = COLORS.land;
    ctx.strokeStyle = COLORS.coast;
    ctx.lineWidth = 0.9;
    for (const polygon of landPolygons) {
      // Cull whole polygons, not individual rings: holes are filled with the
      // outer ring in one even-odd path and cannot be dropped separately.
      if (!intersects(polygon.bbox, view)) continue;
      ctx.beginPath();
      for (const ring of polygon.rings) {
        for (let i = 0; i < ring.length; i += 2) {
          const x = proj.x(ring[i]);
          const y = proj.y(ring[i + 1]);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
      }
      ctx.fill('evenodd');
      ctx.stroke();
    }
  }

  function drawGraticule(ctx, proj) {
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = COLORS.graticule;
    ctx.beginPath();
    for (let lon = -180; lon <= 180; lon += 30) {
      ctx.moveTo(proj.x(lon), proj.y(90));
      ctx.lineTo(proj.x(lon), proj.y(-90));
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      if (lat === 0) continue;
      ctx.moveTo(proj.x(-180), proj.y(lat));
      ctx.lineTo(proj.x(180), proj.y(lat));
    }
    ctx.stroke();

    ctx.beginPath();
    ctx.strokeStyle = COLORS.equator;
    ctx.lineWidth = 1;
    ctx.moveTo(proj.x(-180), proj.y(0));
    ctx.lineTo(proj.x(180), proj.y(0));
    ctx.stroke();
  }

  /**
   * The daylit half of the world, washed with light and edged by the
   * terminator. Follows simulated time, so it sweeps west as the clock runs and
   * swings north or south across the year.
   */
  function drawDayNight(view) {
    const { ctx, proj } = view;
    const sun = subsolarPoint(state.time.current);
    // Whichever pole is in polar day closes the lit polygon.
    const poleLat = sun.lat >= 0 ? 90 : -90;

    const left = proj.x(-180);
    const right = proj.x(180);
    const top = proj.y(90);
    const bottom = proj.y(-90);

    ctx.save();

    // Clip to the lit side; everything below paints through it.
    ctx.beginPath();
    for (let lon = -180; lon <= 180; lon += TERMINATOR_STEP_DEG) {
      const x = proj.x(lon);
      const y = proj.y(terminatorLat(lon, sun));
      if (lon === -180) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.lineTo(right, proj.y(poleLat));
    ctx.lineTo(left, proj.y(poleLat));
    ctx.closePath();
    ctx.clip();

    ctx.fillStyle = COLORS.day;
    ctx.fillRect(left, top, right - left, bottom - top);

    // A glow under the sun, so the lit side reads as lit from somewhere rather
    // than as a flat panel. Drawn at the seam copies too, since the lit half
    // wraps once the sun is past +-90 degrees of longitude.
    const radius = proj.x(90) - proj.x(0);
    for (const shift of [-360, 0, 360]) {
      const cx = proj.x(sun.lon + shift);
      if (cx + radius < left || cx - radius > right) continue;
      const cy = proj.y(sun.lat);
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      glow.addColorStop(0, COLORS.sunGlow);
      glow.addColorStop(1, COLORS.sunGlowEdge);
      ctx.fillStyle = glow;
      // Only the disc the gradient reaches. Filling the world rectangle per
      // copy costs several times the fill for no extra pixels.
      const x0 = Math.max(left, cx - radius);
      const x1 = Math.min(right, cx + radius);
      ctx.fillRect(x0, top, x1 - x0, bottom - top);
    }

    ctx.restore();

    // The terminator line, drawn after the clip is released so it sits centred
    // on the boundary instead of being halved by it.
    ctx.beginPath();
    for (let lon = -180; lon <= 180; lon += TERMINATOR_STEP_DEG) {
      const x = proj.x(lon);
      const y = proj.y(terminatorLat(lon, sun));
      if (lon === -180) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = COLORS.terminator;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  function drawFootprints(view, f) {
    const { ctx } = view;
    const opacity = state.opts.footprintOpacity;
    const alpha = opacity * FOOTPRINT_ALPHA_MAX;
    const selectedAlpha = opacity * FOOTPRINT_SELECTED_ALPHA_MAX;
    for (const fp of f.footprints) {
      if (!tracePaths(view, fp.rings, true)) continue;
      ctx.fillStyle = fp.color;
      ctx.globalAlpha = fp.highlighted ? selectedAlpha : alpha;
      ctx.fill();

      // Stroke the disc's own edge, not the path that was just filled: over a
      // pole that path includes the closure walls, which are not a boundary.
      if (fp.highlighted && fp.outline && tracePaths(view, fp.outline, false)) {
        ctx.globalAlpha = 0.75;
        ctx.strokeStyle = fp.color;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Great-circle chain joining each plane's satellites, in orbit order. */
  function drawPlaneRings(view, f) {
    const { ctx } = view;
    ctx.lineWidth = 1.2;
    ctx.globalAlpha = 0.9;
    for (const ring of f.planePaths) {
      ctx.strokeStyle = ring.color;
      if (tracePaths(view, ring.segments, false)) ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawGroundTrack(view, f) {
    const { ctx } = view;
    if (!f.trackPaths.length) return;
    ctx.lineWidth = 1.4;
    ctx.globalAlpha = 0.85;
    ctx.setLineDash([4, 4]);
    // Each track in its own satellite's colour, so a pair of them reads as two
    // orbits rather than one crossing itself.
    for (const track of f.trackPaths) {
      ctx.strokeStyle = track.color;
      if (tracePaths(view, track.segments, false)) ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  function drawVisibilityLines(view, f) {
    const { ctx } = view;
    if (!f.linkSegments.length) return;
    ctx.strokeStyle = COLORS.link;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.3;
    if (tracePaths(view, f.linkSegments, false)) ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /**
   * Screen-space unit vector along a satellite's direction of travel.
   *
   * Built from where it will be shortly, not from a bearing: projecting both
   * ends gives the screen angle directly, whatever the projection does to it.
   */
  function headingVector(view, dot) {
    const { proj } = view;
    let lon = dot.ahead.lon;
    // The lead point may have crossed the seam. Bring it back alongside the
    // satellite, or the arrow points the long way round the map.
    if (lon - dot.lon > 180) lon -= 360;
    if (lon - dot.lon < -180) lon += 360;

    const dx = proj.x(lon) - proj.x(dot.lon);
    const dy = proj.y(dot.ahead.lat) - proj.y(dot.lat);
    const len = Math.hypot(dx, dy);
    return len > 1e-6 ? [dx / len, dy / len] : null;
  }

  /** Arrowhead just ahead of the mark, in the satellite's own colour. */
  function drawHeading(view, dot, x, y, r, scale) {
    const dir = headingVector(view, dot);
    if (!dir) return;

    const { ctx } = view;
    const [ux, uy] = dir;
    // Perpendicular, for the two back corners of the head.
    const [nx, ny] = [-uy, ux];
    const half = HEADING_HALF_PX * scale;
    const base = r + (SAT_KNOCKOUT_PX + HEADING_GAP_PX) * scale;
    const tip = base + HEADING_LEN_PX * scale;

    ctx.beginPath();
    ctx.moveTo(x + ux * tip, y + uy * tip);
    ctx.lineTo(x + ux * base + nx * half, y + uy * base + ny * half);
    ctx.lineTo(x + ux * base - nx * half, y + uy * base - ny * half);
    ctx.closePath();

    // Same knockout the marks get. These sit on full-strength footprint discs,
    // the brightest thing on the map.
    ctx.strokeStyle = COLORS.satKnockout;
    ctx.lineWidth = 2 * scale;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.fillStyle = dot.color;
    ctx.fill();
  }

  /** The range line joining a paired satellites. */
  function drawPairLine(view, f) {
    if (!f.pair) return;
    const { ctx } = view;

    ctx.strokeStyle = f.pair.close ? COLORS.conjunctionClose : COLORS.conjunction;
    ctx.lineWidth = PAIR_LINE_WIDTH;
    ctx.setLineDash(PAIR_DASH);
    ctx.globalAlpha = 0.95;
    if (tracePaths(view, f.pair.segments, false)) ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  /**
   * The live separation, in a box on the line.
   *
   * Offset perpendicular to the line rather than sitting on the midpoint: at
   * the distances that matter the two marks are almost touching, and a box
   * centred between them would cover both. The offset is in pixels and the
   * perpendicular is taken in screen space, so the box stands clear of the line
   * whichever way it runs.
   */
  function drawPairLabel(view, f) {
    if (!f.pair) return;
    const { ctx, proj } = view;
    const [midLat, midLon] = f.pair.mid;

    // greatCircleMidpoint normalises its longitude, so this is already the copy
    // the line was drawn on. Off the canvas it is skipped outright: the box is
    // one readout, and there is nothing to gain from clamping it to an edge
    // where it would point at a line that is not there.
    const mx = proj.x(midLon);
    const my = proj.y(midLat);
    if (!onCanvas(mx, my, view)) return;

    // Screen-space direction of the line, from the two ends. The far end is
    // brought back alongside the near one first: a pair straddling the seam has
    // longitudes 358 degrees apart, and taken raw the direction would run the
    // long way round the map and throw the box out sideways.
    let lonB = f.pair.b[1];
    if (lonB - f.pair.a[1] > 180) lonB -= 360;
    if (lonB - f.pair.a[1] < -180) lonB += 360;

    const dx = proj.x(lonB) - proj.x(f.pair.a[1]);
    const dy = proj.y(f.pair.b[0]) - proj.y(f.pair.a[0]);

    const km = f.pair.rangeKm;
    const text = `${km < 10 ? km.toFixed(2) : km.toFixed(1)} km`;
    const color = f.pair.close ? COLORS.conjunctionClose : COLORS.conjunction;

    const size = labelSize(markScale(view.zoom));
    const pad = size * 0.42;
    ctx.font = `600 ${size.toFixed(1)}px ${LABEL_FAMILY}`;
    ctx.textBaseline = 'middle';

    const boxW = ctx.measureText(text).width + pad * 2;
    const boxH = size + pad;
    const [ox, oy] = labelOffsetAcross(dx, dy, boxW / 2, boxH / 2, PAIR_LABEL_GAP_PX);
    const cx = mx + ox;
    const cy = my + oy;

    // The stem first, so the box is what covers its inner end. Drawing it
    // afterwards would mean working out where the box boundary falls along a
    // direction that changes with the pair.
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(mx, my);
    ctx.lineTo(cx, cy);
    ctx.stroke();

    // A filled box, not the outline the name labels use: this is one readout
    // rather than eighty, and it has to hold over a track, a footprint or the
    // daylit half without being read as another satellite's name.
    ctx.fillStyle = COLORS.labelBg;
    ctx.fillRect(cx - boxW / 2, cy - boxH / 2, boxW, boxH);
    ctx.strokeRect(cx - boxW / 2 - 0.5, cy - boxH / 2 - 0.5, boxW + 1, boxH + 1);

    ctx.fillStyle = color;
    ctx.fillText(text, cx - boxW / 2 + pad, cy);
    ctx.textBaseline = 'alphabetic';
  }

  function drawSatellites(view, f) {
    const { ctx, proj } = view;
    const scale = markScale(view.zoom);

    for (const dot of f.dots) {
      const x = proj.x(dot.lon);
      const y = proj.y(dot.lat);
      if (!onCanvas(x, y, view)) continue;
      const hovered = hoverSatId === dot.id;
      const r = markRadius({ selected: dot.selected, hovered, spare: dot.spare }) * scale;

      // The globe draws the same mark, from the same function - see
      // markTexture() in symbology.js.
      drawMark(ctx, x, y, r, {
        color: dot.color,
        scale,
        selected: dot.selected,
        ringed: dot.highlighted || hovered,
        spare: dot.spare,
      });

      if (dot.ahead) drawHeading(view, dot, x, y, r, scale);
    }
  }

  /** SV designations beside each mark, when satellite names are on. */
  function drawSatLabels(view, f) {
    if (!f.showNames) return;
    const { ctx, proj } = view;

    const scale = markScale(view.zoom);
    const size = labelSize(scale);

    ctx.font = `500 ${size.toFixed(1)}px ${LABEL_FAMILY}`;
    ctx.textBaseline = 'middle';
    // Dark outline rather than a backing box: 80 filled rectangles would bury
    // the map. It thickens with the type, or large text ends up held worse
    // than small.
    ctx.lineWidth = size / 3;
    ctx.strokeStyle = LABEL_OUTLINE;
    ctx.lineJoin = 'round';

    for (const dot of f.dots) {
      const px = proj.x(dot.lon);
      const py = proj.y(dot.lat);
      if (!onCanvas(px, py, view)) continue;
      // Measured off the edge of the mark, not its centre, so the gap stays
      // even as the marks grow.
      const r = markRadius({ selected: dot.selected, spare: dot.spare }) * scale;
      const x = px + r + (SAT_KNOCKOUT_PX + LABEL_GAP_PX) * scale;
      ctx.strokeText(dot.label, x, py);
      // The satellite's own colour, unadjusted: a label belongs to its mark and
      // its plane line, and reads as theirs only if it matches exactly. The
      // dark outline above is what carries it over a bright footprint.
      ctx.fillStyle = dot.color;
      ctx.fillText(dot.label, x, py);
    }
    ctx.textBaseline = 'alphabetic';
  }

  /**
   * A bright crest sweeping each visibility line from ground site to satellite.
   * On its own canvas, so animating it at refresh rate does not drag the 66
   * footprints on the overlay along with it.
   */
  function drawLinkPulses(view) {
    if (!state || !frame || !state.opts.showVisLines) return;
    const { ctx, proj } = view;

    clipToWorld(ctx, proj);
    const phase = (performance.now() % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
    ctx.lineCap = 'round';
    ctx.strokeStyle = COLORS.linkPulse;

    for (const path of frame.linkSegments) {
      if (!intersects(path.bbox, view)) continue;
      const points = path.points;

      for (let i = 1; i < points.length; i += 1) {
        const a = points[i - 1];
        const b = points[i];

        // Distance from the crest, wrapped so the pulse re-enters smoothly.
        let d = (a[2] + b[2]) / 2 - phase;
        d -= Math.round(d);
        const glow = Math.exp(-(d * d) / (2 * PULSE_SIGMA * PULSE_SIGMA));
        if (glow < 0.02) continue;

        ctx.globalAlpha = glow;
        ctx.lineWidth = 1 + 2.2 * glow;
        ctx.beginPath();
        ctx.moveTo(proj.x(a[1]), proj.y(a[0]));
        ctx.lineTo(proj.x(b[1]), proj.y(b[0]));
        ctx.stroke();
      }
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawHoverLabel(view, f) {
    const dot = hoverSatId && f.dots.find((d) => d.id === hoverSatId);
    if (!dot) return;
    const sat = state.sats.find((x) => x.id === dot.id);
    if (!sat) return;
    const { ctx, proj } = view;

    // One step up from the name labels: this is the one the pointer asked for.
    const scale = markScale(view.zoom);
    const size = labelSize(scale) + 1;
    const pad = size * 0.4;

    ctx.font = `${size.toFixed(1)}px ${LABEL_FAMILY}`;
    const text = sat.label;
    const w = ctx.measureText(text).width;
    const reach = markRadius({ hovered: true }) * scale + (SAT_KNOCKOUT_PX + LABEL_GAP_PX) * scale;
    let x = proj.x(dot.lon) + reach;
    const y = proj.y(dot.lat) - reach;
    // Flip against the visible viewport, not the padded canvas: the padding is
    // off screen, so a label that fits it would still be cut off.
    if (x + w + pad * 2 > view.right) x = proj.x(dot.lon) - w - reach - pad * 2;

    const boxTop = y - size;
    const boxHeight = size + pad;
    ctx.fillStyle = COLORS.labelBg;
    ctx.fillRect(x - pad, boxTop, w + pad * 2, boxHeight);
    ctx.strokeStyle = 'rgba(122, 168, 212, 0.7)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x - pad - 0.5, boxTop - 0.5, w + pad * 2 + 1, boxHeight + 1);
    ctx.fillStyle = COLORS.label;
    ctx.fillText(text, x, y);
  }

  /**
   * Trace bounded rings of [lat, lon] into a path, skipping any that cannot
   * reach the canvas. Returns false if nothing was traced, so the caller can
   * skip the fill or stroke too.
   */
  function tracePaths(view, paths, close) {
    const { ctx, proj } = view;
    let traced = false;
    ctx.beginPath();
    for (const path of paths) {
      if (!intersects(path.bbox, view)) continue;
      const pts = path.points;
      for (let i = 0; i < pts.length; i += 1) {
        const x = proj.x(pts[i][1]);
        const y = proj.y(pts[i][0]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      if (close) ctx.closePath();
      traced = true;
    }
    return traced;
  }

  // ----------------------------------------------------------- ground sites

  function renderSites(st) {
    // Same growth curve as the satellite marks and labels, so a site never
    // looks over- or under-sized next to the constellation at a given zoom.
    const scale = markScale(map.getZoom());

    for (const site of st.sites) {
      let marker = siteMarkers.get(site.name);
      if (!marker) {
        marker = L.marker([site.lat, site.lon], {
          pane: 'sitePane',
          icon: L.divIcon({
            className: 'site-icon',
            html: `<div class="site-mark"><span class="site-dot"></span><span class="site-label">${escapeHtml(site.short || site.name)}</span></div>`,
            iconSize: [10, 10],
            iconAnchor: [5, 5],
          }),
          keyboard: false,
        });
        marker.bindTooltip(site.name, { direction: 'top', offset: [0, -8] });
        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          if (handlers.onSelectSite) handlers.onSelectSite(site.name);
        });
        marker.addTo(siteLayer);
        siteMarkers.set(site.name, marker);
      }
      const el = marker.getElement();
      if (!el) continue;
      el.classList.toggle('selected', st.selectedSiteName === site.name);
      const mark = el.querySelector('.site-mark');
      if (mark) mark.style.setProperty('--site-scale', scale);
    }
  }

  return {
    kind: '2d',
    map,
    render(next) {
      state = next;
      ensurePulseLoop();
      frame = buildFrame(next);
      renderSites(next);
      layer.redraw();
    },
    focusSat(pos) {
      if (!pos) return;
      // Already on screen needs nothing - always the case when the whole world
      // fits the pane, where recentring would be a pointless jump or refused
      // by maxBounds anyway.
      const target = L.latLng(pos.lat, pos.lon);
      if (map.getBounds().contains(target)) return;
      map.setView(target, map.getZoom(), { animate: false });
    },

    /**
     * Frame a conjunction: centre between the two and zoom until they read as
     * two marks with a measurable gap.
     *
     * The zoom comes from the separation rather than being a fixed level.
     * Approaches run from a couple of kilometres to a few hundred, three orders
     * of magnitude, and one level cannot serve both - it would either put the
     * pair off opposite edges or leave them a single pixel apart.
     *
     * EPSG:4326 makes that arithmetic direct: Leaflet's scale is 256 * 2^zoom
     * pixels for 180 degrees, so the zoom that puts a given angle across a
     * given number of pixels is one logarithm.
     */
    focusConjunction(target, other) {
      const sepDeg = angularSeparation(target.lat, target.lon, other.lat, other.lon) * R2D;

      const size = map.getSize();
      const spanPx = Math.min(size.x, size.y) * PAIR_SPAN_FRACTION;

      // A coincident pair - the two projected onto the same point - has no
      // separation to frame, so it just goes to the closest zoom there is.
      const zoom = sepDeg > 1e-7
        ? Math.log2((spanPx / sepDeg) * (180 / 256))
        : map.getMaxZoom();

      // Centred on the tracked object, not between the two. It is the subject,
      // and putting it in the middle is what lets the map be panned and zoomed
      // around it afterwards without it wandering off. The separation still
      // sets the zoom, so the constellation member stays in frame - at the
      // fraction below it lands well inside the shorter half-axis.
      map.setView(
        L.latLng(target.lat, target.lon),
        Math.min(map.getMaxZoom(), Math.max(PAIR_MIN_ZOOM, zoom)),
        { animate: true, duration: 0.8 },
      );
    },
    invalidateSize: () => map.invalidateSize(),
    destroy: () => {
      if (pulseRequest !== null) cancelAnimationFrame(pulseRequest);
      stopWheelZoom();
      map.remove();
    },
  };
}

/**
 * Latitude where the sun sits on the horizon, for one longitude.
 *
 * Solar elevation is zero where
 *
 *   sin(lat) sin(dec) + cos(lat) cos(dec) cos(H) = 0,   H = lon - sunLon
 *
 * which rearranges to lat = -atan2(cos(dec) cos(H), sin(dec)). The tan form is
 * shorter but divides by tan(dec), which is near zero at an equinox - exactly
 * when the terminator stands up and runs pole to pole. atan2 handles that case
 * by returning +-90, and the lit polygon degenerates to the right pair of
 * meridians on its own.
 *
 * The equation has two roots half a turn apart and atan2 may return either. For
 * a southern declination that is the antipodal one, past 90 degrees; folding it
 * back picks the real terminator, since only one of the pair is a latitude.
 *
 * @param {number} lonDeg
 * @param {{lat: number, lon: number}} sun subsolar point
 * @returns {number} latitude in degrees, within [-90, 90]
 */
function terminatorLat(lonDeg, sun) {
  const hourAngle = (lonDeg - sun.lon) * D2R;
  const dec = sun.lat * D2R;
  const lat = -Math.atan2(Math.cos(dec) * Math.cos(hourAngle), Math.sin(dec)) * R2D;
  if (lat > 90) return lat - 180;
  if (lat < -90) return lat + 180;
  return lat;
}

/* --------------------------------------------------------------- culling */

/** Attach a lat/lon bounding box to a path of [lat, lon] points. */
function boundPath(points) {
  let minLat = Infinity; let maxLat = -Infinity;
  let minLon = Infinity; let maxLon = -Infinity;
  for (const [lat, lon] of points) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return { points, bbox: { minLat, maxLat, minLon, maxLon } };
}

/** Does a lat/lon box reach the part of the world the canvas covers? */
function intersects(bbox, view) {
  return bbox.maxLon >= view.west && bbox.minLon <= view.east
    && bbox.maxLat >= view.south && bbox.minLat <= view.north;
}

/** Is a projected point close enough to the canvas to be worth drawing? */
function onCanvas(x, y, view) {
  return x >= view.left - DOT_MARGIN_PX && x <= view.right + DOT_MARGIN_PX
    && y >= view.top - DOT_MARGIN_PX && y <= view.bottom + DOT_MARGIN_PX;
}

/* ------------------------------------------------------------------ layer */

const ConstellationLayer = L.Layer.extend({
  initialize(drawBase, drawOverlay, drawPulse, drawMarks) {
    this._drawBase = drawBase;
    this._drawOverlay = drawOverlay;
    this._drawPulse = drawPulse;
    this._drawMarks = drawMarks;
    this._origin = null;
    this._baseDirty = true;
  },

  onAdd(map) {
    this._map = map;
    this._base = this._makeCanvas(map);
    this._overlay = this._makeCanvas(map);
    this._pulse = this._makeCanvas(map);
    // In markPane, above the ground-site pane - see the comment where that
    // pane is created in create2DView().
    this._marks = this._makeCanvas(map, 'markPane');
    this._baseCtx = this._base.getContext('2d');
    this._overlayCtx = this._overlay.getContext('2d');
    this._pulseCtx = this._pulse.getContext('2d');
    this._marksCtx = this._marks.getContext('2d');

    // 'move' fires once per frame of a drag or pan. Handled apart from the
    // settled events below, and usually does nothing - see _onMove.
    map.on('moveend zoomend viewreset resize', this._reset, this);
    map.on('move', this._onMove, this);
    if (map.options.zoomAnimation && L.Browser.any3d) map.on('zoomanim', this._animateZoom, this);
    this._reset();
  },

  onRemove(map) {
    map.off('moveend zoomend viewreset resize', this._reset, this);
    map.off('move', this._onMove, this);
    map.off('zoomanim', this._animateZoom, this);
    if (this._frameRequest) cancelAnimationFrame(this._frameRequest);
    L.DomUtil.remove(this._base);
    L.DomUtil.remove(this._overlay);
    L.DomUtil.remove(this._pulse);
    L.DomUtil.remove(this._marks);
  },

  _makeCanvas(map, paneName) {
    // leaflet-zoom-animated makes the transform from _animateZoom follow
    // Leaflet's zoom transition, instead of snapping to the end state and
    // sitting there scaled until the animation finishes.
    const canvas = L.DomUtil.create('canvas', 'constellation-canvas leaflet-zoom-animated');
    canvas.style.position = 'absolute';
    const pane = paneName ? map.getPane(paneName) : map.getPanes().overlayPane;
    pane.appendChild(canvas);
    return canvas;
  },

  /**
   * Ride Leaflet's zoom animation on a transform, then repaint when it ends.
   * Same arithmetic as L.Renderer, with the padding allowed for.
   */
  _animateZoom(e) {
    const map = this._map;
    const scale = map.getZoomScale(e.zoom, this._zoom);
    const offset = map.getSize().multiplyBy(-scale * (0.5 + PAD))
      .add(map.project(this._center, this._zoom))
      .subtract(map._getNewPixelOrigin(e.center, e.zoom));
    L.DomUtil.setTransform(this._base, offset, scale);
    L.DomUtil.setTransform(this._overlay, offset, scale);
    L.DomUtil.setTransform(this._pulse, offset, scale);
    L.DomUtil.setTransform(this._marks, offset, scale);
  },

  /**
   * Panning is free while the viewport stays inside what is painted: the
   * canvases sit in the overlay pane and Leaflet transforms it for the whole
   * drag. Only a drag that reaches the padding needs a repaint, and that is
   * coalesced to one per frame.
   */
  _onMove() {
    if (!this._map || !this._origin) return;
    const size = this._map.getSize();
    const p = this._map.layerPointToContainerPoint(this._origin);
    if (p.x <= 0 && p.y <= 0 && p.x + this._width >= size.x && p.y + this._height >= size.y) return;
    this._scheduleReset();
  },

  _reset() {
    if (!this._map) return;
    const map = this._map;
    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;

    const zoom = map.getZoom();
    const width = Math.round(size.x * (1 + PAD * 2));
    const height = Math.round(size.y * (1 + PAD * 2));
    const origin = map.containerPointToLayerPoint([-size.x * PAD, -size.y * PAD]).round();

    // One zoom fires zoomend, moveend and viewreset; one invalidateSize fires
    // moveend and resize. The pixels depend only on anchor, zoom and size, so
    // once those match the last paint, the rest of the gesture has nothing to
    // do.
    const settled = this._origin !== null && this._origin.equals(origin)
      && this._zoom === zoom && this._width === width && this._height === height;

    this._center = map.getCenter();
    this._zoom = zoom;
    this._width = width;
    this._height = height;
    this._origin = origin;

    for (const canvas of [this._base, this._overlay, this._pulse, this._marks]) {
      L.DomUtil.setTransform(canvas, null, 1);
      L.DomUtil.setPosition(canvas, origin);
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
    }

    if (this._resetRequest) {
      cancelAnimationFrame(this._resetRequest);
      this._resetRequest = null;
    }
    if (settled) return;

    // Repaint synchronously. The canvases have just moved to the new view, so
    // deferring to the next frame would leave the old image at the new offset -
    // the map showing the wrong part of the world until the frame lands.
    if (this._frameRequest) {
      cancelAnimationFrame(this._frameRequest);
      this._frameRequest = null;
    }
    this._baseDirty = true;
    this._render();
  },

  _scheduleReset() {
    if (this._resetRequest) return;
    this._resetRequest = requestAnimationFrame(() => {
      this._resetRequest = null;
      this._reset();
    });
  },

  /**
   * Coalesce data redraws to one per animation frame: Leaflet can fire events
   * faster than the display refreshes.
   *
   * View changes go through _reset() instead, which paints synchronously.
   */
  redraw() {
    if (this._frameRequest) return;
    this._frameRequest = requestAnimationFrame(() => {
      this._frameRequest = null;
      this._render();
    });
  },

  /** redraw(), plus the basemap: new coastlines, or a fit to the world. */
  redrawAll() {
    this._baseDirty = true;
    this.redraw();
  },

  /**
   * The drawing view, in layer coordinates. That is what keeps the canvases
   * independent of where the map pane sits: mid-drag the pane moves and these
   * numbers do not.
   */
  _view() {
    const proj = projector(this._map);
    const origin = this._origin;
    return {
      proj,
      // Marks and labels size off this. Everything else here is layer pixels,
      // which give distances but not how far zoomed in the map is.
      zoom: this._map.getZoom(),
      left: origin.x,
      top: origin.y,
      right: origin.x + this._width,
      bottom: origin.y + this._height,
      west: proj.lon(origin.x),
      east: proj.lon(origin.x + this._width),
      north: proj.lat(origin.y),
      south: proj.lat(origin.y + this._height),
    };
  },

  _paint(ctx, drawFn, view) {
    const dpr = window.devicePixelRatio || 1;
    const origin = this._origin;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(-origin.x, -origin.y);
    ctx.clearRect(origin.x, origin.y, this._width, this._height);
    drawFn({ ...view, ctx });
  },

  _render() {
    if (!this._map || !this._overlay.width) return;
    const view = this._view();

    if (this._baseDirty) {
      this._paint(this._baseCtx, this._drawBase, view);
      this._baseDirty = false;
    }
    this._paint(this._overlayCtx, this._drawOverlay, view);
    this._paint(this._pulseCtx, this._drawPulse, view);
    this._paint(this._marksCtx, this._drawMarks, view);
  },

  /**
   * Repaint the animated links alone. The frame-rate path: it touches neither
   * the basemap nor the constellation, so it is cheap enough to run every
   * frame.
   */
  renderPulse() {
    if (!this._map || !this._pulse.width) return;
    this._paint(this._pulseCtx, this._drawPulse, this._view());
  },
});

/**
 * Linear lat/lon to layer-pixel mapping, and back.
 *
 * Exact in EPSG:4326, which is the reason the map uses it: projecting a point
 * is a multiply and an add, not a trip through Leaflet's CRS.
 *
 * Scale comes from map.project(), which is sub-pixel. Do not derive it from
 * latLngToContainerPoint(): that rounds to whole pixels, and rounding a
 * one-degree baseline puts points tens of pixels out across the map.
 */
function projector(map) {
  const zoom = map.getZoom();
  const p0 = map.project([0, 0], zoom);
  const p1 = map.project([1, 1], zoom);
  const pixelOrigin = map.getPixelOrigin();

  const kx = p1.x - p0.x;
  const ky = p1.y - p0.y;
  const offsetX = p0.x - pixelOrigin.x;
  const offsetY = p0.y - pixelOrigin.y;

  return {
    x: (lon) => offsetX + lon * kx,
    y: (lat) => offsetY + lat * ky,
    lon: (x) => (x - offsetX) / kx,
    lat: (y) => (y - offsetY) / ky,
  };
}

// How far past "the world fills the pane" zooming out is allowed to go.
// Drawing is clipped to the world rectangle, so this only adds empty space.
const ZOOM_OUT_HEADROOM = 2;

/**
 * Open on the whole world, and keep Leaflet's container size current. The
 * detail panel opening and closing changes the map width, and a stale size
 * throws off hit-testing.
 */
function fitWorld(map, container, layer) {
  let fitted = false;
  const apply = () => {
    // The pane can be measured before layout settles. Retry instead of
    // skipping, or the initial fit to the world never happens.
    if (!container.clientWidth) {
      requestAnimationFrame(apply);
      return;
    }
    map.invalidateSize({ animate: false });

    // The zoom at which the world is exactly as wide as the pane.
    const fitZoom = Math.max(0, Math.log2(container.clientWidth / 512));
    map.setMinZoom(Math.max(0, fitZoom - ZOOM_OUT_HEADROOM));
    if (!fitted) {
      map.setView([15, 0], fitZoom, { animate: false });
      fitted = true;
    }
    layer.redrawAll();
  };
  apply();
  new ResizeObserver(apply).observe(container);
}

/**
 * Continuous wheel zoom, replacing Leaflet's.
 *
 * Leaflet's is unusable on a trackpad: it batches wheel events for 40 ms then
 * runs a 250 ms animation per batch, and Map._tryAnimatedZoom reports
 * "handled" without doing anything when an animation is already running, so
 * about five batches in six are dropped. What survives arrives as lurches, and
 * the default gain is only ~0.2 zoom levels per second of scrolling anyway.
 *
 * Here the wheel drives a target zoom, and once per frame the map eases toward
 * it with animate:false. That path always applies, and a full repaint of all
 * three canvases is well under a millisecond.
 *
 * @returns {Function} teardown
 */
function wheelZoom(map, container) {
  let target = null;      // null when settled; the next gesture starts from the map
  let anchor = null;      // container point the zoom is centred on: the cursor
  let anchorLatLng = null;// what sits under it, held there for the whole gesture
  let request = null;
  let lastTime = 0;

  const step = (now) => {
    request = null;
    // The +/- control and double click animate their own zoom. Driving both at
    // once fights, so drop ours and let the one-shot gesture win.
    if (map._animatingZoom) { target = null; return; }

    const zoom = map.getZoom();
    // A frame can be arbitrarily late: a background tab hands back the whole
    // time it was away, which without a ceiling lands as one huge jump.
    const dt = Math.min(now - lastTime, 50);
    lastTime = now;

    let next = zoom + (target - zoom) * (1 - Math.exp(-dt / ZOOM_TAU_MS));
    if (Math.abs(target - next) < ZOOM_EPSILON) next = target;

    if (next !== zoom) {
      // Solve for the centre that puts anchorLatLng back under the cursor,
      // rather than nudging. setZoomAround works from wherever the last frame
      // left the map, and over ~30 frames that rounding walks the point ~8 px
      // out from under the cursor.
      const viewHalf = map.getSize().divideBy(2);
      const centre = map.unproject(
        map.project(anchorLatLng, next).subtract(anchor.subtract(viewHalf)), next,
      );
      map.setView(centre, next, { animate: false });
    }

    if (Math.abs(target - map.getZoom()) < ZOOM_EPSILON) target = null;
    else request = requestAnimationFrame(step);
  };

  const onWheel = (e) => {
    // Both matter: without preventDefault the page scrolls under the map, and
    // a ctrl+wheel pinch zooms the whole document instead of the map.
    L.DomEvent.stop(e);

    let px = e.deltaY;
    if (e.deltaMode === 1) px *= WHEEL_LINE_PX;
    else if (e.deltaMode === 2) px *= map.getSize().y;
    if (e.ctrlKey) px *= ZOOM_PINCH_GAIN;

    // Accumulate onto the target, not the current zoom. A flick is scrolling
    // faster than the easing settles, and reading the map back each time would
    // swallow most of it.
    const from = target === null ? map.getZoom() : target;
    const limited = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), from - px / ZOOM_PX_PER_LEVEL));
    if (limited === target) return;
    target = limited;
    // Re-anchor on every event, as Leaflet does: moving the cursor mid-gesture
    // should move what the zoom heads for.
    anchor = map.mouseEventToContainerPoint(e);
    anchorLatLng = map.containerPointToLatLng(anchor);

    if (request === null) {
      lastTime = performance.now();
      request = requestAnimationFrame(step);
    }
  };

  L.DomEvent.on(container, 'wheel', onWheel);
  return () => {
    L.DomEvent.off(container, 'wheel', onWheel);
    if (request !== null) cancelAnimationFrame(request);
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
