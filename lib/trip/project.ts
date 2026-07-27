import type { LatLng } from "@/lib/schemas";

/** Position inside the map panel, as a percentage of width and height. */
export type ProjectedPoint = { xPct: number; yPct: number };

/** Keeps pins clear of the panel edges and its overlay chrome. */
const PADDING_PCT = 12;

/**
 * Projects coordinates into the map placeholder's box.
 *
 * Longitude is scaled by cos(latitude) so the relative layout of the pins is
 * geographically honest rather than horizontally stretched — the same correction
 * a web-Mercator projection applies. It is not a real map projection, and it is
 * not meant to survive the switch to Google Maps; it exists so the placeholder
 * shows a recognisable arrangement of stops instead of an arbitrary scatter.
 */
export function projectPoints(points: LatLng[]): ProjectedPoint[] {
  if (points.length === 0) return [];

  const meanLat =
    points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const lngScale = Math.cos((meanLat * Math.PI) / 180) || 1;

  const xs = points.map((point) => point.lng * lngScale);
  const ys = points.map((point) => point.lat);

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  // Keep the aspect ratio of the real spread rather than stretching each axis
  // to fill the box independently, which would distort tight clusters badly.
  const span = Math.max(spanX, spanY);

  const usable = 100 - PADDING_PCT * 2;

  return points.map((point, index) => {
    if (span === 0) {
      // A single stop, or several at the same coordinates.
      return { xPct: 50, yPct: 50 };
    }

    const centeredX = xs[index] - (minX + maxX) / 2;
    const centeredY = ys[index] - (minY + maxY) / 2;

    return {
      xPct: 50 + (centeredX / span) * usable,
      // Screen y grows downward; latitude grows upward.
      yPct: 50 - (centeredY / span) * usable,
    };
  });
}
