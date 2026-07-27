import { ImageResponse } from "next/og";

/**
 * The social preview, generated from JSX rather than checked in as a binary.
 *
 * ## Why this and not a PNG in `public/`
 *
 * A committed image is a file nobody can edit without a design tool, and it drifts the moment the
 * palette or the pitch changes. This is the same cream/forest/terracotta system the app uses, in
 * source, so a colour change is a one-line edit and the preview cannot silently stop matching the
 * product.
 *
 * `next/og` ships with Next, so this adds no dependency. It renders at request time on the Node
 * runtime and is cached by Vercel's CDN — for an image that changes only when this file does, that is
 * the right trade.
 *
 * ## What it may not say
 *
 * No live prices, no availability, no booking. The subtitle is the honest pitch: real places from
 * OpenStreetMap, estimates labelled as estimates.
 */

export const alt =
  "Roamly — day-by-day travel plans built from real OpenStreetMap places";

/** 1200×630 is the size every major scraper crops from. */
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          // The app's own cream, forest and terracotta.
          background: "linear-gradient(135deg, #FBF7F0 0%, #F3EADC 100%)",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 16,
              background: "#1F3D33",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {/* The compass rose that doubles as the wordmark glyph in the app header. */}
            <svg width="34" height="34" viewBox="0 0 24 24">
              <path
                d="M12 2.5 14.6 9.4 21.5 12l-6.9 2.6L12 21.5 9.4 14.6 2.5 12l6.9-2.6z"
                fill="#FBF7F0"
              />
            </svg>
          </div>
          <div style={{ fontSize: 44, color: "#1F3D33", letterSpacing: -1 }}>
            Roamly
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div
            style={{
              fontSize: 76,
              lineHeight: 1.05,
              color: "#1F3D33",
              letterSpacing: -2.5,
              maxWidth: 900,
            }}
          >
            Trips worth taking, planned properly
          </div>
          <div
            style={{
              fontSize: 30,
              lineHeight: 1.35,
              color: "#5A5248",
              maxWidth: 880,
            }}
          >
            Day-by-day itineraries built around your budget and pace — every stop a
            real, verified place from OpenStreetMap.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            fontSize: 22,
            color: "#5A5248",
          }}
        >
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: 5,
              background: "#C2643C",
            }}
          />
          {/* Stated on the preview itself, so the claim is bounded before anyone clicks. */}
          <div>Prices are planning estimates · No account, no API key required</div>
        </div>
      </div>
    ),
    size,
  );
}
