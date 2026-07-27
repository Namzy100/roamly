/**
 * The one place a tile or style URL is allowed to appear.
 *
 * Nothing else in the codebase references a tile host. Swapping to a dedicated
 * hosted provider, or to a self-hosted OpenMapTiles deployment, is an edit to
 * `BASEMAP_STYLE_URL` alone.
 *
 * ## Why OpenFreeMap
 *
 * Key-free, billing-free, and OpenStreetMap-derived. No account, no API key, no
 * cloud project, no payment card — which is the whole constraint for this
 * project. The `positron` style is a light, desaturated basemap that sits under
 * the cream/forest/terracotta palette without competing with it.
 *
 * ## Usage limits — read before deploying anything real
 *
 * OpenFreeMap is a donation-funded community service. It is appropriate for a
 * low-traffic portfolio demo and local development, and **not** for production
 * traffic. Before this app carries real users, move to one of:
 *
 *   - a paid hosted tile provider (MapTiler, Stadia, Protomaps)
 *   - a self-hosted OpenMapTiles / Planetiler deployment
 *   - any other OSM-compatible vector tile source
 *
 * We must not work around those limits: no bulk tile downloading, no offline
 * caching of tiles, no prefetching beyond what the viewport needs, and no
 * stripping of identifying request headers. `MAX_ZOOM` and the absence of any
 * prefetch configuration below are part of keeping that promise.
 */

/** OpenFreeMap's `positron` style — vector tiles, no key required. */
const DEFAULT_BASEMAP_STYLE_URL = "https://tiles.openfreemap.org/styles/positron";

/**
 * The style in use, overridable per deployment.
 *
 * `NEXT_PUBLIC_` is correct here and is not a leak: a tile style URL is fetched *by the browser*, so
 * it has to reach the client to work at all, and it is public information by construction — anyone
 * can read it from the network tab. Keyed providers put their key in this URL, which is exactly why
 * the variable is documented as "only ever a URL you are willing to publish": a provider requiring a
 * secret token needs a server-side proxy, not this variable.
 *
 * Swapping to MapTiler, Stadia, Protomaps or a self-hosted OpenMapTiles deployment is one environment
 * variable and no code change — and it changes nothing about the itinerary, routing, pool or
 * persistence contracts, because no other module knows a tile host exists.
 */
export const BASEMAP_STYLE_URL =
  process.env.NEXT_PUBLIC_BASEMAP_STYLE_URL?.trim() || DEFAULT_BASEMAP_STYLE_URL;

/** True when the deployment is still on the shared community tiles. Used by the docs, not the UI. */
export const USING_DEFAULT_BASEMAP =
  BASEMAP_STYLE_URL === DEFAULT_BASEMAP_STYLE_URL;

/**
 * Attribution is mandatory and must stay visible.
 *
 * The style's TileJSON already carries OpenStreetMap, OpenMapTiles and
 * OpenFreeMap credit, and MapLibre's `AttributionControl` renders it from the
 * source automatically. This constant is the fallback shown by the non-MapLibre
 * fallback renderer, which has no TileJSON to read. Never hide, cover, shorten
 * or restyle either one into illegibility.
 */
export const OSM_ATTRIBUTION_HTML =
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors · <a href="https://openfreemap.org" target="_blank" rel="noopener noreferrer">OpenFreeMap</a>';

/** Plain-text form, for the fallback panel and accessible labels. */
export const OSM_ATTRIBUTION_TEXT =
  "© OpenStreetMap contributors · OpenFreeMap";

/**
 * Camera limits. `MAX_FIT_ZOOM` stops a single-marker day from zooming to
 * building level, which looks broken and pulls more tiles than it needs.
 */
export const MIN_ZOOM = 2;
export const MAX_ZOOM = 18;
export const MAX_FIT_ZOOM = 15.5;

/** Padding, in pixels, when fitting the camera to a set of places. */
export const FIT_PADDING = { top: 56, right: 40, bottom: 72, left: 40 };

/** Fallback camera when a trip somehow has no mappable places at all. */
export const DEFAULT_CENTER = { longitude: -9.1393, latitude: 38.7223 };
export const DEFAULT_ZOOM = 11;
