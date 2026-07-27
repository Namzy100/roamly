import type { Metadata, Viewport } from "next";
import { Fraunces, Inter } from "next/font/google";

import "./globals.css";

/**
 * Editorial serif for display, clean sans for body — the two typefaces the
 * visual direction calls for. Both are exposed as CSS variables and consumed by
 * `--font-display` / `--font-body` in globals.css.
 */
const display = Fraunces({
  variable: "--font-display",
  subsets: ["latin"],
  display: "swap",
});

const body = Inter({
  variable: "--font-body",
  subsets: ["latin"],
  display: "swap",
});

/**
 * The canonical origin, configurable per deployment.
 *
 * `metadataBase` is what turns the relative `opengraph-image` path into the absolute URL scrapers
 * require. Without it Next warns and falls back to `localhost`, which would put a localhost URL in
 * every shared link — so the fallback here is the production host rather than a dev one, and a
 * preview deployment sets `NEXT_PUBLIC_SITE_URL` to its own origin.
 *
 * `NEXT_PUBLIC_` is correct and deliberate: this is a public URL, not a secret, and the value has to
 * reach the browser for canonical tags to resolve.
 */
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ??
  "https://roamly.vercel.app";

const TITLE = "Roamly — Trips worth taking, planned properly";
const DESCRIPTION =
  "Day-by-day travel plans built around your budget and pace, with every stop a real, verified place from OpenStreetMap. Prices are planning estimates.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: TITLE, template: "%s · Roamly" },
  /**
   * Under 160 characters, and it makes no claim the app cannot keep.
   *
   * No "live prices", no "book", no "availability" — the honesty rules that govern the interface
   * govern the description too, because a social card is where most people meet the product first.
   */
  description: DESCRIPTION,
  applicationName: "Roamly",
  alternates: { canonical: "/" },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
    siteName: "Roamly",
    url: SITE_URL,
    locale: "en_GB",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
  /**
   * Indexable on purpose: it is a portfolio piece meant to be found. `follow` lets the OpenStreetMap
   * and MapLibre credits in the footer pass link equity to the projects the app depends on.
   */
  robots: { index: true, follow: true },
  category: "travel",
};

export const viewport: Viewport = {
  // The header's cream, so a mobile browser's chrome matches the page instead of flashing white.
  themeColor: "#FBF7F0",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      /**
       * globals.css sets `scroll-behavior: smooth` on <html>. Next needs this
       * attribute to know the smooth scroll is intentional, so it can suppress
       * it during route transitions instead of warning about it.
       */
      data-scroll-behavior="smooth"
      className={`${display.variable} ${body.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col font-sans">{children}</body>
    </html>
  );
}
