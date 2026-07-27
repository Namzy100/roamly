import { format, parseISO } from "date-fns";

import type { Currency } from "@/lib/schemas";

/**
 * Display helpers. Deliberately locale-fixed to `en-GB` so server and client
 * render byte-identical strings — a locale-sensitive formatter is a common
 * source of hydration mismatches.
 */

export function formatMoney(
  amount: number,
  currency: Currency,
  options: { compact?: boolean } = {},
): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    maximumFractionDigits: options.compact || amount % 1 === 0 ? 0 : 2,
    minimumFractionDigits: 0,
  }).format(amount);
}

export function formatDuration(minutes: number): string {
  if (minutes < 1) return "moments";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) return `${hours} hr`;
  return `${hours} hr ${rest} min`;
}

export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/** "12 Sep 2026" */
export function formatDate(iso: string): string {
  return format(parseISO(iso), "d MMM yyyy");
}

/** "Sat 12 Sep" */
export function formatDayLabel(iso: string): string {
  return format(parseISO(iso), "EEE d MMM");
}

/** "Sat" */
export function formatWeekdayShort(iso: string): string {
  return format(parseISO(iso), "EEE");
}

/** "12" */
export function formatDayOfMonth(iso: string): string {
  return format(parseISO(iso), "d");
}

/** "12–16 Sep 2026", collapsing a shared month or year. */
export function formatDateRange(startIso: string, endIso: string): string {
  const start = parseISO(startIso);
  const end = parseISO(endIso);
  const sameYear = start.getFullYear() === end.getFullYear();
  const sameMonth = sameYear && start.getMonth() === end.getMonth();
  if (sameMonth) {
    return `${format(start, "d")}–${format(end, "d MMM yyyy")}`;
  }
  if (sameYear) {
    return `${format(start, "d MMM")} – ${format(end, "d MMM yyyy")}`;
  }
  return `${format(start, "d MMM yyyy")} – ${format(end, "d MMM yyyy")}`;
}

/** "09:30 – 10:30" */
export function formatTimeRange(start: string, end: string): string {
  return `${start} – ${end}`;
}

/** Turns a kebab-case enum value into a display label. */
export function humanizeSlug(slug: string): string {
  return slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, " ");
}
