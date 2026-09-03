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
import { EARTH_RADIUS_KM, greatCircleArc, subsolarPoint, destination } from './geo.js';
import { MAP_COLORS } from './palette.js';
import { loadLand, renderBasemapTile } from './basemap.js';
import {
  markTexture, siteTexture, labelSize, markRadius,
  GLOBE_MARK_SCALE, SAT_KNOCKOUT_PX, LABEL_GAP_PX, LABEL_FAMILY,
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
  const headingEntities = [];
  let trackEntity = null;
  let terminatorEntity = null;

  // Highlighted satellites and the point each is flying towards. Rebuilt every
  // render, read by the heading entities' CallbackProperties.
  let headings = [];

  // Latest state, read by the CallbackProperties below.
  //
  // Line geometry goes through CallbackProperty rather than reassigning
  // `positions` each tick: reassignment does not reliably rebuild the geometry,
  // and removing and re-adding entities leaves ground geometry never finishing
  // its async build.
  let current = null;
  let hoverSatId = null;

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

  const trackPositions = () => {
    if (!current || !current.track || current.track.length < 2) return [];
    // Each sample carries its altitude, so this traces the orbit itself, not
    // its shadow on the ground.
    return Cesium.Cartesian3.fromDegreesArrayHeights(
      current.track.flatMap(([lat, lon, altKm]) => [lon, lat, altKm * 1000]),
    );
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

  /**
   * The stub of orbit a highlighted satellite is about to fly.
   *
   * Stands in for the map's fixed-size arrowhead, which does not work on a
   * globe: a screen glyph cannot be pinned to a point that rotates out of
   * view.
   */
  const headingPositions = (i) => {
    const heading = headings[i];
    if (!heading) return [];
    const { pos } = heading;
    return [
      Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, pos.altKm * 1000),
      Cesium.Cartesian3.fromDegrees(pos.ahead.lon, pos.ahead.lat, pos.ahead.altKm * 1000),
    ];
  };

  // Hide satellites behind the Earth.
  //
  // The points set disableDepthTestDistance so they draw crisply over the
  // globe, which also stops the depth buffer hiding the ones round the back.
  // This horizon test does that instead, and only for satellites: turning on
  // depthTestAgainstTerrain globally would z-fight the footprints and site
  // markers sitting at ground level.
  const occluder = new Cesium.EllipsoidalOccluder(viewer.scene.globe.ellipsoid);
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
            font: `500 ${SITE_LABEL_PX}px ${LABEL_FAMILY}`,
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

    for (const sat of state.sats) {
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
      const color = Cesium.Color.fromCssColorString(cssColor);
      const selected = state.selectedSatId === sat.id;
      const highlighted = state.isHighlighted(sat);
      const cart = Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, pos.altKm * 1000);

      const spare = sat.status === 'spare';
      const hovered = hoverSatId === sat.id;
      const mark = markTexture({
        color: cssColor, spare, selected, hovered, ringed: highlighted || hovered,
      });

      if (!entity) {
        const satId = sat.id;
        entity = viewer.entities.add({
          id: `sat:${satId}`,
          position: cart,
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
            font: `500 ${GLOBE_LABEL_PX}px ${LABEL_FAMILY}`,
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
      } else {
        entity.position = cart;
      }

      entity.show = true;
      // Swapping the image is how state shows on the globe: the texture cache
      // means each appearance is drawn once for the whole session.
      entity.billboard.image = mark.canvas;
      entity.billboard.scale = mark.scale;
      entity.label.fillColor = color;
      entity.label.pixelOffset = new Cesium.Cartesian2(labelOffset(spare, selected), 0);

      const wantFootprint = state.opts.showFootprints || highlighted;
      if (wantFootprint) {
        const radiusM = pos.gammaRad * EARTH_RADIUS_KM * 1000;
        const surface = Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, 0);
        if (!footprint) {
          footprint = viewer.entities.add({
            id: `fp:${sat.id}`,
            position: surface,
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
        } else {
          footprint.position = surface;
          footprint.ellipse.semiMajorAxis = radiusM;
          footprint.ellipse.semiMinorAxis = radiusM;
        }
        footprint.show = true;
        footprint.ellipse.material = color.withAlpha(state.opts.footprintOpacity
          * (highlighted ? FOOTPRINT_SELECTED_ALPHA_MAX : FOOTPRINT_ALPHA_MAX));
        // Only a highlighted footprint is stroked, as on the map.
        footprint.ellipse.outline = highlighted;
        footprint.ellipse.outlineColor = color.withAlpha(0.75);
      } else if (footprint) {
        footprint.show = false;
      }
    }

    // Orbit path of the selected satellite, one revolution either side of now,
    // at the altitude it flies. No seam handling needed in 3D.
    if (!trackEntity) {
      trackEntity = viewer.entities.add({
        polyline: {
          positions: new Cesium.CallbackProperty(trackPositions, false),
          width: 2,
          // NONE, not GEODESIC: geodesic arcs drape onto the ellipsoid,
          // which would flatten the orbit onto the surface.
          arcType: Cesium.ArcType.NONE,
          material: new Cesium.PolylineDashMaterialProperty({ color: Cesium.Color.WHITE }),
        },
      });
    }
    trackEntity.show = Boolean(state.track && state.track.length > 1);
    if (trackEntity.show) {
      trackEntity.polyline.material = new Cesium.PolylineDashMaterialProperty({
        color: Cesium.Color.fromCssColorString(state.trackColor || '#ffffff'),
      });
    }

    // Direction stubs for the highlighted satellites.
    headings = [];
    for (const sat of state.sats) {
      const pos = state.positions.get(sat.id);
      if (!pos || !pos.ahead || !state.isHighlighted(sat)) continue;
      headings.push({ id: sat.id, pos, color: satColor(sat, state.planes) });
    }
    while (headingEntities.length < headings.length) {
      const i = headingEntities.length;
      headingEntities.push(viewer.entities.add({
        polyline: {
          positions: new Cesium.CallbackProperty(() => headingPositions(i), false),
          width: 3,
          arcType: Cesium.ArcType.NONE,
          material: Cesium.Color.WHITE,
        },
      }));
    }
    headingEntities.forEach((entity, i) => {
      const heading = headings[i];
      entity.show = Boolean(heading);
      if (!heading) return;
      // Swap the material only when this slot changes colour. The highlighted
      // set is stable for long stretches and every assignment allocates.
      if (entity._headingColor !== heading.color) {
        entity._headingColor = heading.color;
        entity.polyline.material = Cesium.Color.fromCssColorString(heading.color).withAlpha(0.9);
      }
    });

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
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, 14000000),
      duration: 1.2,
    });
  }

  return {
    kind: '3d',
    viewer,
    render,
    focusSat,
    invalidateSize: () => viewer.resize(),
    destroy: () => {
      clickHandler.destroy();
      hoverHandler.destroy();
      viewer.destroy();
    },
  };
}
