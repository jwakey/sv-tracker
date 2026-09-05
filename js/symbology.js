// How a satellite and a ground site are drawn, for both views.
//
// The 2D map draws these straight onto its canvas. The globe cannot - Cesium's
// point primitive has only a fill and an outline, so a three-zone mark cannot
// be expressed as one - so it renders the same functions into a small canvas
// and hands that to a billboard. Same code, same pixels, both views.

import { MAP_COLORS } from './palette.js';

// The satellite mark is three concentric zones: core, plane-coloured annulus,
// dark knockout ring. The core holds contrast on any background - black for
// mission (non-spare) satellites, pale for spares, so it never blends into the
// dark knockout around it - and the knockout separates the mark from the plane
// line drawn through it. Keep the core small - past about a third of the
// radius it swamps the plane colour.
export const SAT_CORE_RATIO = 0.3;
export const SAT_KNOCKOUT_PX = 1.4;

// Base radii, at MARK_ZOOM_REF. Operational marks are smallest because there
// are 66 of them and they crowd each other; spare, hover and selected step up.
export const SAT_R_OPERATIONAL = 4.4;
export const SAT_R_SPARE = 5.2;
export const SAT_R_HOVER = 6.2;
export const SAT_R_SELECTED = 7.2;

// Marks and labels are sized in pixels, not degrees - drawn on the ground they
// would be specks at world view and blotches at zoom 7. They do grow with the
// zoom, geometrically and clamped at both ends, so zooming in actually gets
// closer without a mark swallowing the track it sits on.
export const MARK_ZOOM_REF = 2;
const MARK_GROWTH_PER_LEVEL = 1.2;
const MARK_SCALE_MIN = 0.95;
const MARK_SCALE_MAX = 2.4;

// The globe has no zoom levels to scale from, so it draws marks at one fixed
// step up from the reference. Chosen to match the weight of the 2D map at the
// zoom where you can see a good part of a hemisphere - which is what the globe
// shows most of the time.
export const GLOBE_MARK_SCALE = 1.25;

// Label type. Anything under ~11 px stops resolving at a glance over a
// footprint disc, which is the background these actually sit on.
export const LABEL_BASE_PX = 12;
export const LABEL_MIN_PX = 11;
export const LABEL_MAX_PX = 19;
export const LABEL_GAP_PX = 3;
// Everything drawn on the map or the globe is set in the interface sans, the
// same stack the chrome uses.
//
// It was monospace, and that is what made the labels look hand-spaced. A fixed
// pitch gives every glyph the same cell, so "IRIDIUM 33 DEB" comes out with a
// gulf either side of each I and an M crushed against its neighbours, and
// "39.6 km" puts a full cell around the point and the space. The eye reads the
// uneven ink as bad alignment.
//
// The range readout is a value that runs down several times a second, which is
// the case for a fixed pitch - but only for the digits, and every face in this
// stack draws its digits on one width already. So the readout holds still
// without the rest of the string being stretched onto a grid it does not want.
export const LABEL_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

// One weight for every label drawn on the map or the globe. Named rather than
// written out at each call site: the range readout was set a step heavier than
// the names it sits among, which is the kind of difference that is invisible
// in the source and obvious on screen.
export const LABEL_WEIGHT = 500;
export const LABEL_OUTLINE = 'rgba(8, 11, 14, 0.95)';

// Direction arrow on a highlighted satellite: a small head just clear of the
// mark, pointing the way it is flying. Sized in pixels, not along the track, so
// it stays a glyph at every zoom.
export const HEADING_GAP_PX = 3;
export const HEADING_LEN_PX = 7;
export const HEADING_HALF_PX = 3.2;

/** Scale factor for marks and labels at a given map zoom. */
export function markScale(zoom) {
  const raw = MARK_GROWTH_PER_LEVEL ** ((zoom === undefined ? MARK_ZOOM_REF : zoom) - MARK_ZOOM_REF);
  return Math.min(MARK_SCALE_MAX, Math.max(MARK_SCALE_MIN, raw));
}

/** Unscaled radius for a mark in a given state. Hover only shows in 2D. */
export function markRadius({ selected, hovered, spare, paired }) {
  // Both halves of an approach are drawn at one size, whichever of them is
  // selected and whatever either one is. An approach is a thing that happens
  // between two objects, and a mark half again as wide as the one it is being
  // measured against reads as the more important end of it. Which one is
  // clicked is still there in the ring: two pixels for the selection, one for
  // the highlight.
  if (paired) return SAT_R_OPERATIONAL;
  if (selected) return SAT_R_SELECTED;
  if (hovered) return SAT_R_HOVER;
  return spare ? SAT_R_SPARE : SAT_R_OPERATIONAL;
}

/**
 * Where to put a label that measures a line, so it does not sit on it.
 *
 * Takes the line's direction in screen space and returns a pixel offset from
 * its midpoint, across the line rather than along it. Screen y runs downward in
 * both a canvas context and Cesium's window coordinates, so one function serves
 * the map and the globe alike.
 *
 * How far it has to go is the box's own reach in that direction. For an
 * axis-aligned rectangle that is `halfW*|nx| + halfH*|ny|` - the support
 * function - which is the furthest any part of the box, corners included,
 * projects along n. Pushing the centre that far plus `gap` puts the whole box
 * clear by `gap` at every angle.
 *
 * The two obvious shortcuts both fail. A flat offset clears a horizontal line
 * and leaves a vertical one running through the middle of a box sixty pixels
 * wide. Scaling each axis by its own half-extent fixes those two orientations
 * and still lets a corner cut the line at forty-five degrees, where the corner
 * reaches half again as far as either edge.
 *
 * Which side it lands on is simply the left of the line's own direction, taken
 * as it comes. Preferring a side - always above, say, or always to the right -
 * needs a rule to choose between the two perpendiculars, and any such rule has
 * to change its mind somewhere: the box then jumps bodily across the line as
 * the pair rotates through whatever orientation the rule turns on. Since the
 * two ends are always given in the same order, tracked object first, taking the
 * perpendicular as it comes is both stable and continuous, and never snaps.
 *
 * @param {number} dx screen-space run of the line
 * @param {number} dy screen-space rise of the line, positive downward
 * @param {number} halfW half the label box width, in pixels
 * @param {number} halfH half the label box height, in pixels
 * @param {number} gap clearance to leave between box and line
 * @returns {[number, number]} pixel offset from the midpoint
 */
export function labelOffsetAcross(dx, dy, halfW, halfH, gap) {
  const len = Math.hypot(dx, dy);

  // A degenerate line - both ends on one pixel, which is where a very close
  // approach ends up - has no direction to cross, so the label goes above.
  let nx = 0;
  let ny = -1;

  if (len > 1e-6) {
    nx = -dy / len;
    ny = dx / len;
  }

  const reach = halfW * Math.abs(nx) + halfH * Math.abs(ny) + gap;
  return [nx * reach, ny * reach];
}

/** Label size for a given mark scale, clamped at both ends. */
export function labelSize(scale) {
  return Math.min(LABEL_MAX_PX, Math.max(LABEL_MIN_PX, LABEL_BASE_PX * scale));
}

/**
 * The mark itself: knockout, annulus, core, and the state ring outside them.
 *
 * Rings ride outside the knockout, so they read as a state on the mark rather
 * than another zone of it. Highlighted gets the thin ring: with every spare
 * wearing one, the heavy ring still means "clicked".
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} r mark radius, already scaled
 * @param {{color: string, scale: number, selected?: boolean, ringed?: boolean, spare?: boolean}} opts
 */
export function drawMark(ctx, x, y, r, { color, scale = 1, selected = false, ringed = false, spare = false }) {
  const knockout = SAT_KNOCKOUT_PX * scale;
  const disc = (radius, fill) => {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
  };

  disc(r + knockout, MAP_COLORS.satKnockout);
  disc(r, color);
  disc(r * SAT_CORE_RATIO, spare ? MAP_COLORS.satCore : MAP_COLORS.satCoreMission);

  if (ringed || selected) {
    ctx.beginPath();
    ctx.arc(x, y, r + knockout, 0, Math.PI * 2);
    ctx.lineWidth = (selected ? 2 : 1) * scale;
    ctx.strokeStyle = MAP_COLORS.selection;
    ctx.stroke();
  }
}

/** A ground site: a hollow square, so it never reads as a satellite. */
export function drawSiteMark(ctx, x, y, size, { selected = false } = {}) {
  const half = size / 2;
  const color = selected ? MAP_COLORS.selection : MAP_COLORS.site;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = color;
  ctx.strokeRect(x - half, y - half, size, size);
  ctx.fillStyle = color;
  ctx.fillRect(x - half + 2, y - half + 2, size - 4, size - 4);
}

// ---------------------------------------------------------------- textures

// Only a handful of appearances ever exist - three colours by four states - so
// every texture is built once and kept.
const textures = new Map();

/**
 * How many texture pixels to draw per on-screen pixel.
 *
 * A billboard is sized in CSS pixels, so on a 2x display a 1x texture is
 * stretched over four device pixels and looks soft. Drawing at the display's
 * own density and handing back the matching scale fixes that everywhere the
 * texture is used.
 */
function superSample() {
  const dpr = typeof window === 'undefined' ? 1 : (window.devicePixelRatio || 1);
  return Math.min(3, Math.max(1, Math.round(dpr)));
}

/**
 * A mark rendered into its own canvas, for the globe's billboards.
 *
 * Drawn at the display's pixel density and handed back with the scale to use,
 * so it stays crisp on a high-density display without the caller doing the
 * arithmetic.
 *
 * @returns {{canvas: HTMLCanvasElement, scale: number, radius: number}}
 */
export function markTexture({
  color, spare = false, selected = false, ringed = false, hovered = false, paired = false,
}) {
  const key = `${color}|${spare}|${selected}|${ringed}|${hovered}|${paired}`;
  const cached = textures.get(key);
  if (cached) return cached;

  const scale = GLOBE_MARK_SCALE;
  const r = markRadius({ selected, hovered, spare, paired }) * scale;
  // Room for the knockout, the state ring and its stroke width.
  const pad = SAT_KNOCKOUT_PX * scale + 3;
  const size = Math.ceil((r + pad) * 2);

  const ss = superSample();
  const canvas = document.createElement('canvas');
  canvas.width = size * ss;
  canvas.height = size * ss;
  const ctx = canvas.getContext('2d');
  ctx.scale(ss, ss);
  drawMark(ctx, size / 2, size / 2, r, { color, scale, selected, ringed, spare });

  const out = { canvas, scale: 1 / ss, radius: r };
  textures.set(key, out);
  return out;
}

/** A ground-site mark rendered into its own canvas, for the globe. */
export function siteTexture({ selected = false } = {}) {
  const key = `site|${selected}`;
  const cached = textures.get(key);
  if (cached) return cached;

  const size = 9;
  const pad = 3;
  const box = size + pad * 2;
  const ss = superSample();
  const canvas = document.createElement('canvas');
  canvas.width = box * ss;
  canvas.height = box * ss;
  const ctx = canvas.getContext('2d');
  ctx.scale(ss, ss);
  drawSiteMark(ctx, box / 2, box / 2, size, { selected });

  const out = { canvas, scale: 1 / ss, radius: size / 2 };
  textures.set(key, out);
  return out;
}
