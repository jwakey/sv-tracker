// The map palette, shared by both views.
//
// This lives on its own so the 2D map and the globe cannot drift apart: there
// is one ocean colour, one coastline colour, one amber for links. Chrome
// colours are separate and live in css/style.css.
//
// Three families, one meaning each:
//
//  - green (PLANE_COLOR in classify.js) is the operational constellation;
//  - amber is spares: the marks, the ground links reaching them, and the
//    pulses running up those links. It is the one warm thing on the map, so it
//    separates from the green immediately;
//  - cool slate and steel blue are the basemap. Land, coastlines and graticule
//    are background, and keeping them out of both hues stops them competing.
//
// The day/night wash is the only other warm thing here, and is held an order of
// magnitude dimmer than the links so the two never read as related.
export const MAP_COLORS = {
  ocean: '#0e1215',
  land: '#1e252c',
  coast: '#98a3ad',
  graticule: 'rgba(160, 174, 188, 0.10)',
  equator: 'rgba(160, 174, 188, 0.24)',
  link: '#c8912f',
  linkPulse: '#e6b45c',
  label: '#eef1f4',
  satCore: '#e8edf1',
  // Mission (non-spare) satellites get a black core instead: it holds more
  // contrast than the pale core against a bright plane colour or a lit-up
  // footprint disc.
  satCoreMission: '#000000',
  // Slightly transparent, so it reads as a clearing rather than a punched hole
  // where a mark happens to fall on land or on the daylit side.
  satKnockout: 'rgba(10, 13, 16, 0.9)',
  labelBg: 'rgba(16, 19, 23, 0.97)',
  site: '#e6ebef',
  selection: '#ffffff',

  // Day/night is inverted from the usual terminator overlay. Shading the night
  // side is the normal approach, but on a map this dark it is black on
  // near-black, so the daylit half gets a faint neutral wash instead. Neutral,
  // not warm: a tinted wash reads as an effect, and this is just lighting.
  day: 'rgba(226, 234, 242, 0.045)',
  sunGlow: 'rgba(226, 234, 242, 0.06)',
  sunGlowEdge: 'rgba(226, 234, 242, 0)',
  terminator: 'rgb(79, 163, 247)',

  // The globe draws the day/night boundary as a line rather than relying on
  // shading, so it needs a colour of its own. Cool blue: it belongs to the
  // basemap's slate family, so it reads as lighting rather than data, and it
  // cannot be mistaken for a green orbit, an amber link or a white selection.
  terminatorLine: '#49a9f7',

  // A screened close approach: the line drawn between the pair and the range
  // box sitting on it.
  //
  // Violet by default, matching the tracked object the line starts from - the
  // pairing belongs to it, and a 400 km miss is not an event. It turns red once
  // the two are actually close, which is the one hue nothing else on this map
  // uses: green is the constellation, amber its spares, blue the terminator,
  // white a selection. On a screening display red can only mean one thing, so
  // it is worth keeping unspent until it does.
  conjunction: '#d49bf5',
  conjunctionClose: '#ff6b6b',
};
