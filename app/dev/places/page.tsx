import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SiteFooter, SiteHeader } from "@/components/shell/site-chrome";
import { DevPlacesExplorer } from "@/components/dev/dev-places-explorer";

export const metadata: Metadata = {
  title: "Place discovery (dev)",
  robots: { index: false, follow: false },
};

/**
 * Development-only inspection surface for the OSM provider pipeline.
 *
 * Exists so the discovery layer can be examined *before* any model is wired to it:
 * what came back, what identity each record carries, which optional fields are
 * genuinely missing, and whether the resulting pool validates.
 *
 * `notFound()` in production is checked on the server, so the route does not exist
 * for a real visitor — this is not a client-side hide.
 *
 * Deliberately not production UI: it shows raw canonical ids, discard counts and
 * cache state, none of which belong in front of a traveller.
 */
export default function DevPlacesPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <>
      <SiteHeader />
      <main className="flex-1">
        <DevPlacesExplorer />
      </main>
      <SiteFooter />
    </>
  );
}
