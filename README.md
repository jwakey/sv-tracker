# SV Tracker

A live map of a satellite constellation and the ground sites that track it.
Everything runs in your browser — orbits are calculated locally from public
orbital data, so there's no backend, no account, and no private data
involved anywhere in the app.

Currently configured for the Iridium constellation, but the tracker itself
is general-purpose: swap in a different set of satellites and ground sites
(see [Editing the data](#editing-the-data)) and it works the same way.

## All data is public

Everything this app uses is open, public data:

- **Orbital elements** come from [CelesTrak](https://celestrak.org), a free
  public source for satellite tracking data used by hobbyists and
  professionals alike.
- **Coastline outlines** come from [Natural Earth](https://www.naturalearthdata.com/),
  a public-domain map dataset.
- **Ground site locations** are approximate, published station coordinates,
  editable in a plain JSON file.

Nothing is fetched from or sent to a private server. The app itself has no
login, no tracking, and no backend of its own.

## Running it

Open `index.html` through a local web server rather than double-clicking it,
since the browser needs to fetch the data files:

```bash
python3 -m http.server 8000
```

Then visit <http://localhost:8000>.

## Hosting it

It's a static site — copy the folder to GitHub Pages, Netlify, Cloudflare
Pages, or any web host and it works with no build step. Visitors just need
internet access, since the map libraries and live orbital data load from
public CDNs and CelesTrak.

## What it shows

- **Satellites**, drawn in one colour for the working constellation and amber
  for in-orbit spares.
- **Orbital planes** traced as a line linking the satellites in each plane —
  that link, rather than a per-plane colour, is what separates them.
- **Ground sites**, with lines to any satellites currently visible overhead.
- **Coverage footprints** showing what each satellite can see on the ground.
- **Search** by name or catalog number, with keyboard navigation.
- **Time control** — live, paused, sped up to 600×, or scrubbed ±24 hours.
- **2D map or 3D globe**, toggled from the top bar.

Click any satellite for its full details and orbit path.

## Editing the data

Everything specific to a constellation lives in `data/`, as plain JSON —
edit and reload, no code changes needed:

- **`ground-sites.json`** — the list of ground stations, each with a name,
  coordinates, and elevation mask (how high above the horizon a satellite
  must be to count as visible).
- **`constellation-roster.json`** — which satellites are operational and which
  are spares, grouped by orbital plane. This is the *only* thing that decides
  status, and it sets the plane numbering used throughout the app. Satellites
  are listed by vehicle number (the NNN in the CelesTrak name `IRIDIUM NNN`).
- **`satellite-overrides.json`** — per-satellite corrections that beat the
  roster, keyed by NORAD catalog number. Values are `operational`, `spare` or
  `hidden`.
- **`tle-snapshot.txt`** — an offline fallback set of orbital elements, used
  only if CelesTrak is unreachable. The committed snapshot holds elements from
  1 September 2026 and goes stale from that date, so if you are falling back to
  it rather than reaching CelesTrak live, refresh it with:

  ```bash
  curl -o data/tle-snapshot.txt "https://celestrak.org/NORAD/elements/gp.php?GROUP=iridium-NEXT&FORMAT=tle"
  ```

  (swap `iridium-NEXT` for whatever CelesTrak group matches your
  constellation).

Anything the roster doesn't mention is treated as operational, so a newly
launched satellite shows up as a normal member of the constellation until
someone adds it.

## Note: the old classification mechanic was removed

Earlier versions guessed operational-vs-spare from the orbits themselves, as a
fallback for satellites the roster didn't list. Two heuristics did it: an
**altitude threshold** (the working constellation flies at ~778 km while
parked spares sat between 629 and 763 km, so 772 km split them), and an
**in-plane phasing** check that caught a spare parked at operational altitude
by spotting a plane holding more satellites than its even spacing allowed.

Both are gone. Once the roster listed the whole constellation the heuristics
had nothing left to decide — every satellite was already matched by name
before either one ran, so they never changed an outcome. They were guesswork
sitting in the path of authoritative data, and a wrong guess for some future
launch was the only thing they could still contribute.

Status now comes from the roster and the overrides file, and nothing is
inferred from the orbits. Mean altitude is still calculated and shown in the
detail panel — it's just a readout now, not an input to any decision.

## How it's built

Plain ES modules, no build step, no dependencies to install:

| File | Purpose |
| --- | --- |
| `js/app.js` | State, the animation loop, view switching |
| `js/tle.js` | Fetching, caching and the fallback chain |
| `js/propagate.js` | SGP4 wrappers: position, look angles, ground tracks |
| `js/classify.js` | Roster lookup, orbital plane assignment, mark colours |
| `js/geo.js` | Geodesic circles, antimeridian splitting, pole closure |
| `js/view2d.js` | Leaflet map |
| `js/view3d.js` | Cesium globe, loaded on demand |
| `js/ui.js` | Controls, legend, detail panel |

Propagation is [satellite.js](https://github.com/shashwatak/satellite-js)
(SGP4). The 2D map is [Leaflet](https://leafletjs.com/) with an
equirectangular projection rather than Mercator, since Mercator can't show
the high latitudes many constellations pass over. The 3D globe is
[CesiumJS](https://cesium.com/platform/cesiumjs/), needing no account or
access token.

For poking around, the live state is exposed as `window.iridium` in the
browser console.

## Limitations

- Positions come from SGP4 and are accurate to roughly a kilometre for
  recent elements, degrading over days. The detail panel shows each
  satellite's element age.
- Operational-vs-spare status is only as current as
  `data/constellation-roster.json`. Nothing is inferred from the orbits, so
  the roster has to be kept up to date by hand.
- Needs internet access: the map libraries load from CDNs and orbital
  elements are fetched live from CelesTrak.
