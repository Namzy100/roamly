import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DevRoutingExplorer } from "@/components/dev/dev-routing-explorer";
import { SiteFooter, SiteHeader } from "@/components/shell/site-chrome";

export const metadata: Metadata = {
  title: "Routing (dev)",
  robots: { index: false, follow: false },
};

/**
 * Development-only inspection surface for the routing pipeline.
 *
 * Sits beside `/dev/places` and follows the same rules. It exists so routing can
 * be examined *before* it is wired into itinerary generation: what geometry came
 * back, how it differs from the straight sequence line, which legs failed and
 * why, and whether a repeat request is genuinely served from cache.
 *
 * `notFound()` in production is checked on the server, so the route does not
 * exist for a real visitor — this is not a client-side hide.
 *
 * Deliberately not production UI: it shows canonical ids, shape-point counts,
 * provider names and raw failure reasons, none of which belong in front of a
 * traveller.
 */
export default function DevRoutingPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <>
      <SiteHeader />
      <main className="flex-1">
        <DevRoutingExplorer />
      </main>
      <SiteFooter />
    </>
  );
}
