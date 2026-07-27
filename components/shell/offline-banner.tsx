"use client";

import { CloudOff } from "lucide-react";

import { OFFLINE_MESSAGE } from "@/lib/hooks/use-online-status";
import { useOnlineStatus } from "@/lib/hooks/use-online-status";

/**
 * A single honest line when the browser reports no network.
 *
 * ## Not a full offline application, and it does not pretend to be
 *
 * There is no service worker and no cached shell: a hard reload while offline will not load the app
 * at all. What *does* work is everything already in memory and in `localStorage` — which is most of
 * the product, because trips live in the browser. The wording says exactly that rather than implying
 * offline support.
 *
 * `role="status"` with `aria-live="polite"` so a screen reader is told when connectivity changes
 * without interrupting whatever is being read.
 */
export function OfflineBanner() {
  const online = useOnlineStatus();
  if (online) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="offline-banner"
      className="flex items-start gap-2 border-b border-terracotta/30 bg-terracotta/10 px-5 py-2.5 text-xs leading-relaxed text-ink sm:px-8"
    >
      <CloudOff aria-hidden className="mt-0.5 size-3.5 shrink-0 text-terracotta" />
      <span className="flex-1">{OFFLINE_MESSAGE}</span>
    </div>
  );
}
