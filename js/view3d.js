// 3D globe, built on CesiumJS.
//
// Cesium is ~5 MB, so it loads on demand the first time the globe is opened,
// not on page load. Nothing here contacts Cesium Ion, and no access token is
// needed: the globe wraps itself in a basemap this app draws.
//
// The globe is meant to read as the same instrument as the 2D map, not as a
// different product. Three things make that true rather than approximate:
//
//  - the basemap is the map's own coastlines and palette, rasterised a tile at
//    a time by basemap.js, instead of Cesium's photographic imagery;
//  - satellite and site marks are drawn by the same functions the map uses, in
//    symbology.js, and handed to Cesium as billboards - Cesium's own point
//    primitive has one fill and one outline and cannot express a three-zone
//    mark;
//  - labels, footprints, selection and hover follow the map's rules.

import { satColor } from './classify.js';
import {
  EARTH_RADIUS_KM, greatCircleArc, subsolarPoint, destination,
} from './geo.js';
import { conjunctionColor } from './conjunction.js';
import { MAP_COLORS } from './palette.js';
import { loadLand, renderBasemapTile } from './basemap.js';
import {
  markTexture, siteTexture, labelSize, markRadius, labelOffsetAcross,
  GLOBE_MARK_SCALE, SAT_KNOCKOUT_PX, LABEL_GAP_PX, LABEL_FAMILY, LABEL_WEIGHT,
} from './symbology.js';

const CESIUM_VERSION = '1.121';

/** Subsolar longitude, near enough for framing the opening camera. */
function subsolarLongitude(date) {
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60;
  return ((180 - utcHours * 15) + 540) % 360 - 180;
}

const CESIUM_BASE = `https://cesium.com/downloads/cesiumjs/releases/${CESIUM_VERSION}/Build/Cesium/`;

// Samples between neighbouring satellites on a plane ring. They sit ~32.7
// degrees apart, so a few points is enough to read as a circle instead of an
// 11-sided polygon.
const RING_ARC_STEPS = 8;

// Orbit paths, following the map's ground track. How much orbit they cover is
// settled where the track is built, in app.js - the array holds exactly what is
// drawn - and where the satellite sits in that array comes with it, so the two
// halves meet on the mark rather than near it.
//
// A polyline carries one colour, so each band is its own entity. Eight a side
// is fewer than the map uses: a band on the globe is foreshortened, and past
// the limb it is not visible at all.
const TRACK_BANDS = 8;
const TRACK_ALPHA_AHEAD = 0.95;
const TRACK_ALPHA_BEHIND = 0.9;
// Shapes the fade along each side. Below 1 the line holds most of its
// brightness through the stretch next to the satellite and spends the drop at
// the far end, which is where it is wanted; above 1 it does the opposite and
// is half gone by the middle of its own span.
const TRACK_FADE_POWER = 0.8;

// The flown stretch is solid: a bright core inside a wider, translucent sheath
// of the same colour - the globe's version of the trail the map draws under
// its track. A flat polyline in perspective reads as a decal on the screen: it
// has no depth, and the sphere behind it has plenty.
//
// It is not Cesium's glow material, which was the obvious thing to reach for
// and is wrong here. That shader adds the same glow term to all three channels
// at the centre of the line, so the core saturates to white however it is
// coloured - and on this map the colour is the satellite's identity. A violet
// orbit came out white with a violet edge.
//
// WIDTH_BEHIND is the whole line, core and sheath together; CORE_PX is the
// part of it that is solid.
const TRACK_WIDTH_BEHIND = 5.5;
const TRACK_CORE_PX = 1.8;
const TRACK_HALO_ALPHA = 0.22;

// The stretch to come is dashed, with its gaps filled in the same colour at a
// fraction of the alpha rather than left empty. Same idea as the sheath - the
// dashes carry the reading, the fill carries the continuity - and it costs
// nothing, since a dash material draws its own gaps either way. Without it the
// longer half of the line would be the flat dashed polyline the sheath above
// exists to get away from.
const TRACK_WIDTH_AHEAD = 2.5;
const TRACK_GAP_ALPHA = 0.18;
// Both sides taper to this at the end of their span.
const TRACK_WIDTH_END = 1;

/**
 * How lit a band is: 1 next to the satellite, 0 at the end of its side's span.
 * Bands run outward from the satellite, the flown ones first.
 */
function trackBandFade(band) {
  const u = ((band % TRACK_BANDS) + 0.5) / TRACK_BANDS;
  return (1 - u) ** TRACK_FADE_POWER;
}

/** Alpha and width for a band, from its side and its distance out. */
function trackBandStyle(band) {
  const ahead = band >= TRACK_BANDS;
  const fade = trackBandFade(band);
  const full = ahead ? TRACK_WIDTH_AHEAD : TRACK_WIDTH_BEHIND;
  return {
    ahead,
    alpha: (ahead ? TRACK_ALPHA_AHEAD : TRACK_ALPHA_BEHIND) * fade,
    width: TRACK_WIDTH_END + (full - TRACK_WIDTH_END) * fade,
  };
}

// The terminator: the circle 90 degrees from the subsolar point. Sampled every
// few degrees, floated just above the surface so it cannot z-fight the globe,
// and drawn far brighter than the map's version - on a shaded sphere the line
// has to carry the boundary on its own. Its colour is MAP_COLORS.terminatorLine,
// which is blue for exactly one reason: everything else curving across the
// globe is an orbit.
const TERMINATOR_STEP_DEG = 3;
const TERMINATOR_HEIGHT_M = 20000;
const TERMINATOR_WIDTH = 2;
const TERMINATOR_ALPHA = 0.85;

// Basemap tiles. 512 px at level 6 works out around half a kilometre per pixel,
// which is finer than the 1:110m coastlines it draws - past that the limit is
// the data, not the raster.
const BASEMAP_TILE_PX = 512;
const BASEMAP_MAX_LEVEL = 6;

// Label size on the globe. The map scales its labels with zoom; the globe has
// no zoom levels, so it sits at the size the map uses around its middle.
const GLOBE_LABEL_PX = labelSize(GLOBE_MARK_SCALE);

// Framing for a conjunction. Cesium's default field of view is 60 degrees, so
// standing off by half the span over tan(30 deg) puts a given separation across
// the view; the multiplier below folds in the margin that keeps the pair well
// inside the frame rather than touching its edges.
const PAIR_STANDOFF_RATIO = 3;
// Floor and ceiling on that standoff. The floor is not about the marks - those
// are billboards, sized in pixels however near the camera gets - it is about
// keeping enough of the Earth under the pair to see where the approach happens.
// Below this the view is all satellite and no context; above the ceiling a wide
// miss pulls the camera back until the Earth is a marble again.
const PAIR_STANDOFF_MIN_M = 40000;
const PAIR_STANDOFF_MAX_M = 4000000;
// The range line is a dimension line, as on the map: a fine solid rule with a
// tick across it at each end. It was dashed, which reads as provisional - and
// this is the one quantity on the globe that is measured rather than predicted.
// The orbit tracks have since taken dashes for the stretch still to come, so a
// dashed line between two marks would now say the same thing as a piece of
// orbit running past them.
const PAIR_LINE_WIDTH = 2;
// Half a tick's length, in pixels, matching the map's. Sized on screen rather
// than in space because it is an annotation: a two kilometre miss and a two
// hundred kilometre one get the same end stop, and it does not grow as the
// camera closes on the pair.
const PAIR_TICK_PX = 5;
// The range box: its own padding, and the clearance it keeps from the line it
// measures. Plain numbers, not Cartesian2s - this module is evaluated before
// Cesium is fetched.
const PAIR_LABEL_PAD_X = 7;
const PAIR_LABEL_PAD_Y = 5;
const PAIR_LABEL_GAP_PX = 9;

// The map sets site codes a shade smaller than satellite labels.
const SITE_LABEL_PX = 10.5;

/** Gap from a mark's centre to where its label starts, matching the map. */
function labelOffset(spare, selected) {
  const r = markRadius({ selected, spare }) * GLOBE_MARK_SCALE;
  return r + (SAT_KNOCKOUT_PX + LABEL_GAP_PX) * GLOBE_MARK_SCALE;
}

// Alpha at footprint opacity 1.0. Discs overlap heavily on the globe, so the
// range stays low. The default 0.3 gives the 0.09 and 0.24 these used to be
// fixed at.
const FOOTPRINT_ALPHA_MAX = 0.79;
const FOOTPRINT_SELECTED_ALPHA_MAX = 0.99;

// Uplink pulse: a bright crest running from ground site to satellite, same as
// the 2D map. LENGTH is a fraction of the whole link.
const PULSE_PERIOD_MS = 1100;
const PULSE_LENGTH = 0.25;

let cesiumLoading = null;

/** Inject the Cesium script and stylesheet once. Resolves when ready. */
function loadCesium() {
  if (window.Cesium) return Promise.resolve();
  if (cesiumLoading) return cesiumLoading;

  window.CESIUM_BASE_URL = CESIUM_BASE;
  cesiumLoading = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${CESIUM_BASE}Widgets/widgets.css`;
    document.head.appendChild(css);

    const script = document.createElement('script');
    script.src = `${CESIUM_BASE}Cesium.js`;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Could not load CesiumJS'));
    document.head.appendChild(script);
  });
  return cesiumLoading;
}

/**
 * The map's basemap as a Cesium imagery provider, drawn on demand per tile.
 *
 * Cesium asks for whichever tiles the camera needs at whichever level matches
 * the screen, so the coastline is rasterised at the resolution it is actually
 * being viewed at. One whole-Earth texture cannot do that: it is either soft
 * when zoomed in or enormous.
 */
function basemapProvider(polygons) {
  const tilingScheme = new Cesium.GeographicTilingScheme();
  const size = BASEMAP_TILE_PX;
  return {
    tilingScheme,
    tileWidth: size,
    tileHeight: size,
    minimumLevel: 0,
    maximumLevel: BASEMAP_MAX_LEVEL,
    rectangle: tilingScheme.rectangle,
    hasAlphaChannel: false,
    credit: undefined,
    tileDiscardPolicy: undefined,
    proxy: undefined,
    errorEvent: new Cesium.Event(),
    getTileCredits: () => [],
    pickFeatures: () => undefined,
    requestImage(x, y, level) {
      const r = tilingScheme.tileXYToRectangle(x, y, level);
      const deg = Cesium.Math.toDegrees;
      return Promise.resolve(renderBasemapTile(polygons, {
        west: deg(r.west),
        east: deg(r.east),
        south: deg(r.south),
        north: deg(r.north),
        width: size,
        height: size,
      }));
    },
  };
}

export async function create3DView(container, handlers = {}) {
  const [, land] = await Promise.all([loadCesium(), loadLand()]);

  const viewer = new Cesium.Viewer(container, {
    baseLayer: new Cesium.ImageryLayer(basemapProvider(land)),
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    sceneModePicker: false,
    selectionIndicator: false,
    timeline: false,
    animation: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    shouldAnimate: false,
  });

  // Render at the display's real pixel density. Cesium defaults to the
  // browser's "recommended" resolution, which is CSS pixels - on a 2x display
  // that draws the whole scene at half resolution and scales it up, which is
  // why the globe, its lines and its labels all looked soft while the 2D map
  // (which sizes its own canvases by devicePixelRatio) did not.
  viewer.useBrowserRecommendedResolution = false;

  // With a sharp framebuffer, FXAA is now doing more blurring than it is
  // smoothing. Multisampling gives cleaner polyline edges without the smear.
  viewer.scene.msaaSamples = 4;
  if (viewer.scene.postProcessStages && viewer.scene.postProcessStages.fxaa) {
    viewer.scene.postProcessStages.fxaa.enabled = false;
  }

  // The atmosphere halo is the one thing the flat map has no equivalent for.
  // Kept, dimmed: it is what stops the globe reading as a flat disc.
  viewer.scene.skyAtmosphere.show = true;
  viewer.scene.globe.showGroundAtmosphere = false;
  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString(MAP_COLORS.ocean);
  viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#0a0d10');
  // Day/night contrast. Cesium's shading is a Lambert falloff, which is
  // physically right and visually vague - it never produces an edge. These two
  // push the two halves apart: the multiplier scales the lit side, and the
  // shadow darkness is the floor the unlit side settles at. The terminator
  // line drawn below is what actually marks the boundary.
  viewer.scene.globe.lambertDiffuseMultiplier = 2.1;
  viewer.scene.globe.vertexShadowDarkness = 0.08;

  // Open on the daylit hemisphere, or the globe can look black on first load
  // purely because the camera started over night.
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(subsolarLongitude(new Date()), 20, 32000000),
  });

  const satEntities = new Map();     // satellite id -> entity
  const footprintEntities = new Map();
  const siteEntities = new Map();
  const linkEntities = [];
  const pulseEntities = [];
  const planeRingEntities = new Map(); // plane index -> entity
  const trackEntities = [];
  let terminatorEntity = null;
  let pairEntity = null;
  let pairTickEntities = [];
  let pairLabelEntity = null;
  // The satellite the camera is currently pivoting about, if any. Held by id so
  // the pivot can be released without caring whether the entity still exists.
  let pivotEntityId = null;

  // Latest state, read by the CallbackProperties below.
  //
  // Line geometry goes through CallbackProperty rather than reassigning
  // `positions` each tick: reassignment does not reliably rebuild the geometry,
  // and removing and re-adding entities leaves ground geometry never finishing
  // its async build.
  let current = null;
  let hoverSatId = null;

  // Cesium parses a CSS colour string every time it is handed one, and with an
  // approach up render() runs once a frame over the whole constellation. The
  // palette is a dozen colours that hold for the session.
  const cesiumColors = new Map();
  const cesiumColor = (css) => {
    let color = cesiumColors.get(css);
    if (!color) {
      color = Cesium.Color.fromCssColorString(css);
      cesiumColors.set(css, color);
    }
    return color;
  };

  /**
   * A plane's ring, drawn through its satellites at orbital altitude.
   *
   * Neighbours are joined along the great circle between them, which is the
   * orbit itself since they share a plane, with altitude interpolated along
   * the way. Arc endpoints are the satellite positions, so the line passes
   * through every satellite exactly.
   */
  const ringPositions = (index) => {
    const ring = current && current.planeRings.find((r) => r.index === index);
    if (!ring || ring.points.length < 3) return [];

    // Cesium calls this every frame, but the geometry changes once per tick.
    // state.planeRings is rebuilt each tick, so caching on the ring object
    // invalidates itself.
    if (ring._positions3d) return ring._positions3d;

    const coords = [];
    for (let i = 0; i < ring.points.length; i += 1) {
      const [latA, lonA, altA] = ring.points[i];
      const [latB, lonB, altB] = ring.points[(i + 1) % ring.points.length];
      const arc = greatCircleArc(latA, lonA, latB, lonB, RING_ARC_STEPS);

      // Drop each arc's last sample: it is the next satellite, which the
      // following segment adds as its own first point.
      for (let k = 0; k < arc.length - 1; k += 1) {
        const t = k / (arc.length - 1);
        coords.push(arc[k][1], arc[k][0], (altA + (altB - altA) * t) * 1000);
      }
    }
    // Close the loop back onto the first satellite.
    coords.push(ring.points[0][1], ring.points[0][0], ring.points[0][2] * 1000);

    ring._positions3d = Cesium.Cartesian3.fromDegreesArrayHeights(coords);
    return ring._positions3d;
  };

  /**
   * One orbit cut into TRACK_BANDS runs end to end, cached on the track it came
   * from - the same trick ringPositions() uses, and needed for the same reason.
   * The polylines poll for their positions every frame, while the tracks behind
   * them are rebuilt a few times a second; without the cache this would rebuild
   * six hundred Cartesians ten times over, sixty times a second.
   *
   * Each run keeps the sample the next one starts from, or the orbit would show
   * a gap at every step in the fade.
   */
  const trackBands = (track) => {
    if (track._bands3d) return track._bands3d;
    const points = track.points;
    const now = track.nowIndex;

    track._bands3d = Array.from({ length: TRACK_BANDS * 2 }, (_, band) => {
      const ahead = band >= TRACK_BANDS;
      const step = band % TRACK_BANDS;
      // Each side is measured in its own samples, out from the satellite.
      const reach = ahead ? (points.length - 1 - now) : now;
      const near = (step / TRACK_BANDS) * reach;
      const far = ((step + 1) / TRACK_BANDS) * reach;

      // Rounding outward at both ends is what makes a band overlap its
      // neighbours; without that the orbit shows a gap at every step.
      const from = Math.max(0, Math.floor(ahead ? now + near : now - far));
      const to = Math.min(points.length, Math.ceil(ahead ? now + far : now - near) + 1);
      const run = points.slice(from, to);
      if (run.length < 2) return [];

      // Each sample carries its altitude, so this traces the orbit itself, not
      // its shadow on the ground.
      return Cesium.Cartesian3.fromDegreesArrayHeights(
        run.flatMap(([lat, lon, altKm]) => [lon, lat, altKm * 1000]),
      );
    });
    return track._bands3d;
  };

  const trackPositions = (i, band) => {
    const track = current && current.tracks && current.tracks[i];
    if (!track || track.points.length < 2) return [];
    return trackBands(track)[band];
  };

  /**
   * The material for one band: a dash ahead of the satellite, a sheathed solid
   * line behind it.
   *
   * Rebuilt only when a slot changes colour - a material is an allocation and
   * the caller runs five times a second.
   */
  const trackMaterial = (band, cssColor) => {
    const { ahead, alpha, width } = trackBandStyle(band);
    const color = Cesium.Color.fromCssColorString(cssColor);
    if (ahead) {
      return new Cesium.PolylineDashMaterialProperty({
        color: color.withAlpha(alpha),
        gapColor: color.withAlpha(alpha * TRACK_GAP_ALPHA),
      });
    }

    // outlineWidth is the whole sheath, both sides together, so what is left
    // of the line's width is the solid core.
    return new Cesium.PolylineOutlineMaterialProperty({
      color: color.withAlpha(alpha),
      outlineColor: color.withAlpha(alpha * TRACK_HALO_ALPHA),
      outlineWidth: Math.max(0, width - TRACK_CORE_PX),
    });
  };

  /**
   * The day/night boundary: every point 90 degrees from the subsolar point.
   *
   * Same sun position the 2D map uses, so the two views put the terminator in
   * the same place. Rebuilt each frame it is asked for, which is cheap - a
   * hundred-odd points of spherical trigonometry.
   */
  const terminatorPositions = () => {
    if (!current) return [];
    const sun = subsolarPoint(current.time.current);
    const coords = [];
    for (let bearing = 0; bearing <= 360; bearing += TERMINATOR_STEP_DEG) {
      const [lat, lon] = destination(sun.lat, sun.lon, bearing, Math.PI / 2);
      coords.push(lon, lat, TERMINATOR_HEIGHT_M);
    }
    return Cesium.Cartesian3.fromDegreesArrayHeights(coords);
  };

  // Hide satellites behind the Earth.
  //
  // The points set disableDepthTestDistance so they draw crisply over the
  // globe, which also stops the depth buffer hiding the ones round the back.
  // This horizon test does that instead, and only for satellites: turning on
  // depthTestAgainstTerrain globally would z-fight the footprints and site
  // markers sitting at ground level.
  const occluder = new Cesium.EllipsoidalOccluder(viewer.scene.globe.ellipsoid);
  /** Whether a satellite is one of the two ends of the active approach. */
  const isPaired = (id) => Boolean(current && current.conjunction
    && (current.conjunction.aId === id || current.conjunction.bId === id));

  /** The two ends of the active conjunction, at the altitudes they fly. */
  const pairEnds = () => {
    const pair = current && current.conjunction;
    if (!pair || pair.rangeKm === null || pair.rangeKm === undefined) return null;
    const a = current.positions.get(pair.aId);
    const b = current.positions.get(pair.bId);
    return a && b ? { a, b, rangeKm: pair.rangeKm } : null;
  };

  const pairPositions = () => {
    const ends = pairEnds();
    if (!ends) return [];
    return Cesium.Cartesian3.fromDegreesArrayHeights([
      ends.a.lon, ends.a.lat, ends.a.altKm * 1000,
      ends.b.lon, ends.b.lat, ends.b.altKm * 1000,
    ]);
  };

  /**
   * Midpoint of the line, for the range readout.
   *
   * Straight average of the two Cartesian positions rather than a spherical
   * midpoint: over a separation of tens of kilometres the chord and the arc are
   * the same to well under a pixel, and this is where the line itself is drawn.
   */
  const pairMidpoint = () => {
    const points = pairPositions();
    if (points.length < 2) return Cesium.Cartesian3.ZERO;
    return Cesium.Cartesian3.midpoint(points[0], points[1], new Cesium.Cartesian3());
  };

  const scratchTickDir = new Cesium.Cartesian3();
  const scratchTickAcross = new Cesium.Cartesian3();
  const scratchTickEye = new Cesium.Cartesian3();
  const scratchTickPixel = new Cesium.Cartesian2();

  /**
   * A tick across the line at one of its ends.
   *
   * Square to the line and to the line of sight to this end of it, which puts
   * it in the plane facing the camera: it reads as a tick from wherever the
   * pair is being watched, and both its ends are the same distance away, so it
   * draws its full length instead of running off into depth. Square to the
   * line alone it would be a ring of possible directions, and whichever was
   * picked would foreshorten to nothing as the camera came round to it.
   *
   * The line of sight has to be taken from the camera's world position, not
   * from camera.direction. While an approach is framed the camera is tracking
   * one of the pair, and a tracked camera reports its direction in the tracked
   * entity's own frame - so crossing it with a world-space line gives a
   * direction that means nothing. Pointed near enough along the view axis, the
   * two ends of the tick land at very different depths and perspective draws
   * the few pixels between them as a streak across the whole globe. It grew
   * with the separation, because the tick grows with it, so it only showed
   * well away from the closest approach.
   *
   * @param {number} end 0 for the near end of the line, 1 for the far one.
   */
  const pairTick = (end) => () => {
    const points = pairPositions();
    if (points.length < 2) return [];

    const dir = Cesium.Cartesian3.subtract(points[1], points[0], scratchTickDir);
    if (Cesium.Cartesian3.magnitude(dir) < 1) return [];
    Cesium.Cartesian3.normalize(dir, dir);

    const at = points[end];
    const eye = Cesium.Cartesian3.subtract(viewer.camera.positionWC, at, scratchTickEye);
    const distance = Cesium.Cartesian3.magnitude(eye);
    if (!(distance > 0)) return [];

    const across = Cesium.Cartesian3.cross(dir, eye, scratchTickAcross);
    // The pair seen exactly end-on: the line is a point and there is no across.
    if (Cesium.Cartesian3.magnitude(across) < 1e-6) return [];
    Cesium.Cartesian3.normalize(across, across);

    // What a pixel is worth in metres at this end's own distance, so the two
    // ticks come out the same length on screen however much perspective there
    // is between them. The frustum knows its own field of view and aspect,
    // which is the whole of that sum.
    const pixel = viewer.camera.frustum.getPixelDimensions(
      viewer.scene.drawingBufferWidth,
      viewer.scene.drawingBufferHeight,
      distance,
      viewer.scene.pixelRatio,
      scratchTickPixel,
    );
    Cesium.Cartesian3.multiplyByScalar(across, pixel.y * PAIR_TICK_PX, across);

    return [
      Cesium.Cartesian3.subtract(at, across, new Cesium.Cartesian3()),
      Cesium.Cartesian3.add(at, across, new Cesium.Cartesian3()),
    ];
  };

  // Text metrics for the range box. Cesium lays a label out on the GPU and does
  // not hand the size back, but the offset that keeps the box off the line has
  // to know how wide it is - so it is measured here, with the same font.
  const labelMetrics = document.createElement('canvas').getContext('2d');
  labelMetrics.font = `${LABEL_WEIGHT} ${GLOBE_LABEL_PX}px ${LABEL_FAMILY}`;
  let pairLabelText = null;
  let pairLabelHalfW = 0;

  const scratchPairA = new Cesium.Cartesian3();
  const scratchPairB = new Cesium.Cartesian3();
  const scratchWinA = new Cesium.Cartesian2();
  const scratchWinB = new Cesium.Cartesian2();

  /**
   * Offset that keeps the range box off the line, recomputed per frame.
   *
   * The line's direction on screen is not a property of the pair - it is a
   * property of where the camera happens to be - so this has to project both
   * ends into window coordinates every frame and take the perpendicular there.
   * A fixed offset is what put the box on top of the line for any pair the
   * camera happened to show end-on.
   */
  const pairLabelOffset = (time, result) => {
    const out = result || new Cesium.Cartesian2();
    const ends = pairEnds();

    let dx = 0;
    let dy = 0;
    if (ends) {
      Cesium.Cartesian3.fromDegrees(
        ends.a.lon, ends.a.lat, ends.a.altKm * 1000, undefined, scratchPairA,
      );
      Cesium.Cartesian3.fromDegrees(
        ends.b.lon, ends.b.lat, ends.b.altKm * 1000, undefined, scratchPairB,
      );
      const wa = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, scratchPairA, scratchWinA);
      const wb = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, scratchPairB, scratchWinB);
      // Undefined once an end is behind the camera. The zero direction below
      // falls back to placing the box above, which is as good a guess as any
      // when the line has no on-screen direction at all.
      if (wa && wb) { dx = wb.x - wa.x; dy = wb.y - wa.y; }
    }

    const [ox, oy] = labelOffsetAcross(
      dx, dy, pairLabelHalfW, GLOBE_LABEL_PX / 2 + PAIR_LABEL_PAD_Y, PAIR_LABEL_GAP_PX,
    );
    out.x = ox;
    out.y = oy;
    return out;
  };

  const scratchCart = new Cesium.Cartesian3();
  let lastCameraPosition = null;

  const satVisible = (id) => {
    if (!current) return false;
    const pos = current.positions.get(id);
    if (!pos) return false;

    // Recompute the occluder only when the camera has moved.
    const camera = viewer.camera.positionWC;
    if (!lastCameraPosition || !Cesium.Cartesian3.equals(lastCameraPosition, camera)) {
      occluder.cameraPosition = camera;
      lastCameraPosition = Cesium.Cartesian3.clone(camera, lastCameraPosition || new Cesium.Cartesian3());
    }

    Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, pos.altKm * 1000, undefined, scratchCart);
    return occluder.isPointVisible(scratchCart);
  };

  const linkPositions = (i) => {
    const link = current && current.visLinks[i];
    if (!link) return [];
    return [
      Cesium.Cartesian3.fromDegrees(link.site.lon, link.site.lat, 0),
      Cesium.Cartesian3.fromDegrees(link.pos.lon, link.pos.lat, link.pos.altKm * 1000),
    ];
  };

  const scratchStart = new Cesium.Cartesian3();
  const scratchEnd = new Cesium.Cartesian3();

  /**
   * The pulse crest: a short piece of the link that slides from the ground end
   * to the satellite end and repeats.
   *
   * Cesium owns the render loop, so this is a second short polyline with
   * endpoints recomputed each frame, not a shader.
   */
  const pulsePositions = (i) => {
    const link = current && current.visLinks[i];
    if (!link) return [];

    const ground = Cesium.Cartesian3.fromDegrees(link.site.lon, link.site.lat, 0, undefined, scratchStart);
    const sat = Cesium.Cartesian3.fromDegrees(
      link.pos.lon, link.pos.lat, link.pos.altKm * 1000, undefined, scratchEnd,
    );

    const phase = (performance.now() % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
    const head = phase * (1 + PULSE_LENGTH);
    const tail = Math.max(0, head - PULSE_LENGTH);
    if (tail >= 1) return [];

    return [
      Cesium.Cartesian3.lerp(ground, sat, tail, new Cesium.Cartesian3()),
      Cesium.Cartesian3.lerp(ground, sat, Math.min(1, head), new Cesium.Cartesian3()),
    ];
  };

  const clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  clickHandler.setInputAction((movement) => {
    const picked = viewer.scene.pick(movement.position);
    const id = picked && picked.id && picked.id.id;
    if (typeof id === 'string' && id.startsWith('sat:')) {
      if (handlers.onSelectSat) handlers.onSelectSat(id.slice(4));
    } else if (typeof id === 'string' && id.startsWith('site:')) {
      if (handlers.onSelectSite) handlers.onSelectSite(id.slice(5));
    } else if (handlers.onClearSelection) {
      handlers.onClearSelection();
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // Hover, as on the map: the mark steps up a size and wears a ring, and the
  // cursor says the thing under it is pickable.
  const hoverHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  hoverHandler.setInputAction((movement) => {
    const picked = viewer.scene.pick(movement.endPosition);
    const id = picked && picked.id && picked.id.id;
    const next = typeof id === 'string' && id.startsWith('sat:') ? id.slice(4) : null;
    if (next === hoverSatId) return;
    hoverSatId = next;
    viewer.scene.canvas.style.cursor = next ? 'crosshair' : '';
    // Redraw now rather than waiting for the next data tick, or the mark lags
    // the pointer by up to 200 ms.
    if (current) render(current);
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  function renderSites(state) {
    for (const site of state.sites) {
      const selected = state.selectedSiteName === site.name;
      const mark = siteTexture({ selected });
      let entity = siteEntities.get(site.name);

      if (!entity) {
        entity = viewer.entities.add({
          id: `site:${site.name}`,
          position: Cesium.Cartesian3.fromDegrees(site.lon, site.lat, 0),
          billboard: {
            image: mark.canvas,
            scale: mark.scale,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            // The map shows the short code beside the square, not above it.
            text: site.short || site.name,
            font: `${LABEL_WEIGHT} ${SITE_LABEL_PX}px ${LABEL_FAMILY}`,
            fillColor: Cesium.Color.fromCssColorString(MAP_COLORS.site),
            outlineColor: Cesium.Color.fromCssColorString('#000000').withAlpha(0.9),
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
            pixelOffset: new Cesium.Cartesian2(mark.radius + 5, 0),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
        siteEntities.set(site.name, entity);
      }

      entity.billboard.image = mark.canvas;
      entity.billboard.scale = mark.scale;
      entity.label.fillColor = Cesium.Color.fromCssColorString(
        selected ? MAP_COLORS.selection : MAP_COLORS.site,
      );
    }
  }

  function render(state) {
    current = state;
    renderSites(state);

    // Drive Cesium's clock from simulated time, so the shading follows the
    // scrubber instead of being pinned to page load.
    viewer.clock.currentTime = Cesium.JulianDate.fromDate(state.time.current);
    viewer.scene.globe.enableLighting = state.opts.dayNight;

    if (!terminatorEntity) {
      terminatorEntity = viewer.entities.add({
        polyline: {
          positions: new Cesium.CallbackProperty(terminatorPositions, false),
          width: TERMINATOR_WIDTH,
          // GEODESIC, not NONE: the samples are three degrees apart and the
          // line has to hug the sphere between them.
          arcType: Cesium.ArcType.GEODESIC,
          material: Cesium.Color.fromCssColorString(MAP_COLORS.terminatorLine)
            .withAlpha(TERMINATOR_ALPHA),
        },
      });
    }
    terminatorEntity.show = state.opts.dayNight;

    // Entities persist until told otherwise, and the satellite list is no
    // longer fixed for the session - a tracked object can be dropped. Anything
    // the pass below does not touch is hidden after it.
    const liveSats = new Set();

    for (const sat of state.sats) {
      liveSats.add(sat.id);
      const pos = state.positions.get(sat.id);
      const shown = state.isVisible(sat) && pos;
      let entity = satEntities.get(sat.id);
      let footprint = footprintEntities.get(sat.id);

      if (!shown) {
        if (entity) entity.show = false;
        if (footprint) footprint.show = false;
        continue;
      }

      const cssColor = satColor(sat, state.planes);
      const color = cesiumColor(cssColor);
      const selected = state.selectedSatId === sat.id;
      const highlighted = state.isHighlighted(sat);

      // Everything below writes to an entity only when the value has changed.
      //
      // That is not thrift for its own sake. While an approach is up this pass
      // runs once a frame, but only the two satellites in the pair have been
      // propagated - and assigning to an entity property allocates a Cesium
      // property and raises a change event whether or not the value differs.
      // For a footprint that change event means the whole disc is tessellated
      // and its primitive rebuilt, so writing back the position it already has
      // would rebuild sixty-odd discs a frame to no effect.
      const moved = entity === undefined
        || entity._lat !== pos.lat || entity._lon !== pos.lon || entity._alt !== pos.altKm;

      const spare = sat.status === 'spare';
      const hovered = hoverSatId === sat.id;
      const paired = isPaired(sat.id);
      const mark = markTexture({
        color: cssColor, spare, selected, hovered, paired, ringed: highlighted || hovered,
      });

      if (!entity) {
        const satId = sat.id;
        entity = viewer.entities.add({
          id: `sat:${satId}`,
          position: Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, pos.altKm * 1000),
          billboard: {
            image: mark.canvas,
            scale: mark.scale,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            // Per frame, so satellites vanish behind the Earth as it is
            // rotated, not on the next data tick.
            show: new Cesium.CallbackProperty(() => satVisible(satId), false),
          },
          label: {
            text: sat.label,
            font: `${LABEL_WEIGHT} ${GLOBE_LABEL_PX}px ${LABEL_FAMILY}`,
            // The satellite's own colour, exactly as the map draws it: a label
            // belongs to its mark, and reads as the mark's only if it matches.
            fillColor: color,
            outlineColor: Cesium.Color.fromCssColorString('#080b0e').withAlpha(0.95),
            outlineWidth: GLOBE_LABEL_PX / 6,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            // Off the edge of the mark, to the right, as on the map.
            horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
            pixelOffset: new Cesium.Cartesian2(labelOffset(spare, false), 0),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            show: new Cesium.CallbackProperty(
              () => Boolean(current)
                && (current.opts.showSatNames || current.selectedSatId === satId)
                && satVisible(satId),
              false,
            ),
          },
        });
        satEntities.set(sat.id, entity);
      } else if (moved) {
        entity.position = Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, pos.altKm * 1000);
      }
      entity._lat = pos.lat;
      entity._lon = pos.lon;
      entity._alt = pos.altKm;

      entity.show = true;
      // Swapping the image is how state shows on the globe: the texture cache
      // means each appearance is drawn once for the whole session, and hands
      // back the same object for the same appearance - so this compares marks,
      // not their contents.
      if (entity._mark !== mark) {
        entity._mark = mark;
        entity.billboard.image = mark.canvas;
        entity.billboard.scale = mark.scale;
      }
      if (entity._labelColor !== cssColor) {
        entity._labelColor = cssColor;
        entity.label.fillColor = color;
      }
      const offset = labelOffset(spare, selected);
      if (entity._labelOffset !== offset) {
        entity._labelOffset = offset;
        entity.label.pixelOffset = new Cesium.Cartesian2(offset, 0);
      }

      // Suppressed for catalogue objects and for an approach's pair, as on
      // the map - see hasFootprint().
      const wantFootprint = (state.opts.showFootprints || highlighted)
        && state.hasFootprint(sat);
      if (wantFootprint) {
        const radiusM = pos.gammaRad * EARTH_RADIUS_KM * 1000;
        if (!footprint) {
          footprint = viewer.entities.add({
            id: `fp:${sat.id}`,
            position: Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, 0),
            ellipse: {
              semiMajorAxis: radiusM,
              semiMinorAxis: radiusM,
              material: color.withAlpha(state.opts.footprintOpacity * FOOTPRINT_ALPHA_MAX),
              outline: highlighted,
              outlineColor: color.withAlpha(0.75),
              outlineWidth: 1,
              height: 0,
              granularity: Cesium.Math.RADIANS_PER_DEGREE * 2,
            },
          });
          footprintEntities.set(sat.id, footprint);
        } else if (footprint._lat !== pos.lat || footprint._lon !== pos.lon
          || footprint._radiusM !== radiusM) {
          // Against the disc's own last geometry, not the mark's: a hidden
          // footprint is left where it was while its satellite goes on moving,
          // so it has to catch up the moment it is shown again.
          footprint.position = Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, 0);
          footprint.ellipse.semiMajorAxis = radiusM;
          footprint.ellipse.semiMinorAxis = radiusM;
        }
        footprint._lat = pos.lat;
        footprint._lon = pos.lon;
        footprint._radiusM = radiusM;
        footprint.show = true;

        // Same again for how it is painted: a fresh material every frame would
        // put the disc through the same rebuild as a move.
        const alpha = state.opts.footprintOpacity
          * (highlighted ? FOOTPRINT_SELECTED_ALPHA_MAX : FOOTPRINT_ALPHA_MAX);
        const look = `${cssColor}|${alpha}|${highlighted}`;
        if (footprint._look !== look) {
          footprint._look = look;
          footprint.ellipse.material = color.withAlpha(alpha);
          // Only a highlighted footprint is stroked, as on the map.
          footprint.ellipse.outline = highlighted;
          footprint.ellipse.outlineColor = color.withAlpha(0.75);
        }
      } else if (footprint) {
        footprint.show = false;
      }
    }

    for (const [id, entity] of satEntities) {
      if (!liveSats.has(id)) entity.show = false;
    }
    for (const [id, entity] of footprintEntities) {
      if (!liveSats.has(id)) entity.show = false;
    }

    // The range line between a paired satellites, and its live readout.
    //
    // Straight through space, not draped on the ellipsoid: the pair are two
    // objects at altitude and the quantity being drawn is the distance between
    // them, which is a chord. ArcType.NONE is what keeps it one.
    if (!pairEntity) {
      const rule = (positions) => ({
        polyline: {
          positions: new Cesium.CallbackProperty(positions, false),
          width: PAIR_LINE_WIDTH,
          arcType: Cesium.ArcType.NONE,
          material: new Cesium.ColorMaterialProperty(
            Cesium.Color.fromCssColorString(MAP_COLORS.conjunction),
          ),
        },
      });
      pairEntity = viewer.entities.add(rule(pairPositions));
      // The ticks are their own polylines. One polyline through both would draw
      // the jump between them, which is the line they are already ending.
      pairTickEntities = [
        viewer.entities.add(rule(pairTick(0))),
        viewer.entities.add(rule(pairTick(1))),
      ];
      pairLabelEntity = viewer.entities.add({
        position: new Cesium.CallbackProperty(pairMidpoint, false),
        label: {
          font: `${LABEL_WEIGHT} ${GLOBE_LABEL_PX}px ${LABEL_FAMILY}`,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString(MAP_COLORS.labelBg),
          backgroundPadding: new Cesium.Cartesian2(PAIR_LABEL_PAD_X, PAIR_LABEL_PAD_Y),
          // Centred on the offset, which carries it clear of the line - see
          // pairLabelOffset(). Anchoring it to an edge instead would fight the
          // offset, since which edge faces the line changes with the camera.
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          pixelOffset: new Cesium.CallbackProperty(pairLabelOffset, false),
          // The pair can be on the far side of the globe from the camera while
          // the clock is scrubbed; the line and its box go with them rather
          // than floating over the near face.
          disableDepthTestDistance: 0,
        },
      });
    }

    // The pivot belonged to the approach. Once the pairing goes - because
    // something else was picked, or the object was dropped - the camera comes
    // back rather than staying locked to a satellite nobody is looking at.
    if (!state.conjunction && pivotEntityId) releasePivot();

    const pair = pairEnds();
    pairEntity.show = Boolean(pair);
    pairLabelEntity.show = Boolean(pair);
    for (const tick of pairTickEntities) tick.show = Boolean(pair);
    if (pair) {
      const css = conjunctionColor(pair.rangeKm);
      // Only when the band actually changes. This runs five times a second and
      // a material is an allocation, where the colour holds for whole passes.
      if (pairEntity._pairColor !== css) {
        pairEntity._pairColor = css;
        const color = Cesium.Color.fromCssColorString(css);
        for (const line of [pairEntity, ...pairTickEntities]) {
          line.polyline.material = new Cesium.ColorMaterialProperty(color);
        }
        pairLabelEntity.label.fillColor = color;
      }
      const text = pair.rangeKm < 10
        ? `${pair.rangeKm.toFixed(2)} km`
        : `${pair.rangeKm.toFixed(1)} km`;
      if (pairLabelText !== text) {
        pairLabelText = text;
        pairLabelEntity.label.text = text;
        pairLabelHalfW = labelMetrics.measureText(text).width / 2 + PAIR_LABEL_PAD_X;
      }
    }

    // Orbit paths, one revolution either side of now at the altitude each flies.
    // No seam handling needed in 3D. A pool grown to fit, like the link lines:
    // with a conjunction up there are two of these, and the count changes as
    // the selection does.
    // One polyline per band per track, both sides, so the pool runs
    // TRACK_BANDS * 2 entities for every orbit on screen. A slot's band never
    // changes, so its width is settled once, when the slot is made.
    const perTrack = TRACK_BANDS * 2;
    const tracks = state.tracks || [];
    while (trackEntities.length < tracks.length * perTrack) {
      const i = Math.floor(trackEntities.length / perTrack);
      const band = trackEntities.length % perTrack;
      trackEntities.push(viewer.entities.add({
        polyline: {
          positions: new Cesium.CallbackProperty(() => trackPositions(i, band), false),
          width: trackBandStyle(band).width,
          // NONE, not GEODESIC: geodesic arcs drape onto the ellipsoid,
          // which would flatten the orbit onto the surface.
          arcType: Cesium.ArcType.NONE,
          material: trackMaterial(band, MAP_COLORS.selection),
        },
      }));
    }
    trackEntities.forEach((entity, slot) => {
      const track = tracks[Math.floor(slot / perTrack)];
      entity.show = Boolean(track);
      if (!track) return;
      if (entity._trackColor !== track.color) {
        entity._trackColor = track.color;
        entity.polyline.material = trackMaterial(slot % perTrack, track.color);
      }
    });

    // No direction stub on the globe. A short line running off a mark reads as
    // another orbit rather than as an arrow, and a selected satellite already
    // has its orbit track, which says which way it is going and does so along
    // the whole revolution. The map keeps its arrowhead, which is a glyph on
    // the mark and has neither problem.

    // Great-circle chain joining each plane's satellites in orbit order.
    const live = new Set(state.planeRings.map((r) => r.index));
    for (const ring of state.planeRings) {
      if (!planeRingEntities.has(ring.index)) {
        const index = ring.index;
        planeRingEntities.set(index, viewer.entities.add({
          polyline: {
            positions: new Cesium.CallbackProperty(() => ringPositions(index), false),
            width: 2.2,
            // NONE, not GEODESIC: geodesic arcs drape onto the ellipsoid and
            // would throw away the orbital altitudes.
            arcType: Cesium.ArcType.NONE,
            material: Cesium.Color.fromCssColorString(ring.color).withAlpha(0.8),
          },
        }));
      }
      planeRingEntities.get(ring.index).show = true;
    }
    for (const [index, entity] of planeRingEntities) {
      if (!live.has(index)) entity.show = false;
    }

    // Ground-site visibility lines. Spares only.
    const wanted = state.opts.showVisLines ? state.visLinks.length : 0;
    while (linkEntities.length < wanted) {
      const i = linkEntities.length;
      linkEntities.push(viewer.entities.add({
        polyline: {
          positions: new Cesium.CallbackProperty(() => linkPositions(i), false),
          width: 1.5,
          material: Cesium.Color.fromCssColorString('#c8912f').withAlpha(0.7),
          arcType: Cesium.ArcType.NONE,
        },
      }));
    }
    linkEntities.forEach((entity, i) => { entity.show = i < wanted; });

    while (pulseEntities.length < wanted) {
      const i = pulseEntities.length;
      pulseEntities.push(viewer.entities.add({
        polyline: {
          positions: new Cesium.CallbackProperty(() => pulsePositions(i), false),
          width: 4,
          arcType: Cesium.ArcType.NONE,
          material: new Cesium.PolylineGlowMaterialProperty({
            color: Cesium.Color.fromCssColorString('#e6b45c'),
            glowPower: 0.25,
          }),
        },
      }));
    }
    pulseEntities.forEach((entity, i) => { entity.show = i < wanted; });

    viewer.scene.requestRender();
  }

  function focusSat(pos) {
    if (!pos) return;
    // Any deliberate camera move releases the pivot first, or Cesium's tracking
    // would keep re-centring on the old target and fight the flight.
    releasePivot();
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, 14000000),
      duration: 1.2,
    });
  }

  /** Hand the camera back, if we were the ones holding it. */
  function releasePivot() {
    if (!pivotEntityId) return;
    pivotEntityId = null;
    viewer.trackedEntity = undefined;
  }

  /**
   * Frame a conjunction: down onto the midpoint, from a standoff worked out
   * from how far apart the two actually are.
   *
   * Not a fixed altitude like focusSat's. Approaches span three orders of
   * magnitude, and the camera has to end up close enough that a few kilometres
   * is a visible gap without flying so close for a wide miss that both objects
   * leave the frame.
   */
  function focusConjunction(target, other, targetId) {
    // The true separation, straight from the inertial positions. The ground arc
    // between the two sub-points would understate a pair separated mostly by
    // altitude - one passing directly over the other - and fly the camera in
    // far too close.
    const sepM = Math.hypot(
      target.eci.x - other.eci.x,
      target.eci.y - other.eci.y,
      target.eci.z - other.eci.z,
    ) * 1000;

    const standoff = Math.min(
      PAIR_STANDOFF_MAX_M,
      Math.max(PAIR_STANDOFF_MIN_M, sepM * PAIR_STANDOFF_RATIO),
    );

    const entity = satEntities.get(targetId);
    if (!entity) {
      // No entity yet - the first render has not run. Fall back to flying to
      // the position, which at least puts the approach on screen.
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          target.lon, target.lat, target.altKm * 1000 + standoff,
        ),
        duration: 1.6,
      });
      return;
    }

    // Hand the camera to Cesium's entity tracking, with the tracked object as
    // the pivot. This is what makes the object the centre of the view rather
    // than something that happens to be in it: drag and the camera orbits the
    // satellite instead of the globe, zoom and it closes on the satellite, and
    // if the clock is started again the camera follows it round rather than
    // watching it leave.
    //
    // viewFrom is the offset the camera takes up in the target's east-north-up
    // frame, and setting it is not optional: without one Cesium falls back to
    // the entity's bounding sphere, and a billboard's is a couple of metres
    // across, so the camera ends up inside the mark.
    //
    // Forty-five degrees, not overhead. Two satellites can miss each other
    // horizontally or by altitude, and a near-nadir view collapses the second
    // case completely - one passes directly under the other and the two marks
    // land on the same pixel, which is exactly the geometry the polar
    // approaches have. An oblique view has no degenerate direction: it shows
    // about seven tenths of a separation whichever way it points.
    const oblique = standoff * Math.SQRT1_2;
    entity.viewFrom = new Cesium.Cartesian3(0, -oblique, oblique);
    pivotEntityId = targetId;
    viewer.trackedEntity = entity;
  }

  return {
    kind: '3d',
    viewer,
    render,
    focusSat,
    focusConjunction,
    invalidateSize: () => viewer.resize(),
    destroy: () => {
      clickHandler.destroy();
      hoverHandler.destroy();
      viewer.destroy();
    },
  };
}
