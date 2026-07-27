"use client";

import {
  AlertTriangle,
  Bike,
  Car,
  Database,
  Footprints,
  RouteOff,
  Search,
  Waypoints,
} from "lucide-react";
import { useRef, useState } from "react";

import { MapPanel } from "@/components/map/map-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DiscoverResponseSchema,
  GeocodeResponseSchema,
  type GeocodeResponse,
} from "@/lib/api/places-contract";
import {
  DayApiResponseSchema,
  type DayApiResponse,
} from "@/lib/api/routing-contract";
import { formatDistance, formatDuration } from "@/lib/format";
import type { MapRouteLine, VisibleMapPlace } from "@/lib/map/types";
import {
  ROUTING_MODE_LABELS,
  durationSecondsToMinutes,
  type RoutingMode,
} from "@/lib/routing";
import { placeCategoryLabel, type TripPlace } from "@/lib/schemas/place";
import { cn } from "@/lib/utils";

type Candidate = GeocodeResponse["candidates"][number];

const DISCOVERY_CATEGORIES = ["museum", "viewpoint", "cafe"] as const;
const DISCOVERY_RADIUS_METERS = 2_000;

const MODE_ICONS = {
  walk: Footprints,
  drive: Car,
  bicycle: Bike,
} as const;

/**
 * Dev-only explorer for the routing pipeline.
 *
 * Geocode → discover → pick two or more places → choose a mode → route. The
 * point is to make every claim in the routing layer checkable by eye: that a
 * routed line differs from the sequence line, that duration and distance match
 * the normalised result, that a cache hit spares the provider a request, and
 * that an unavailable leg draws nothing at all.
 *
 * Explicit submits throughout, never search-as-you-type — the same rule the
 * places surface follows, for the same reason, and it now applies to a second
 * volunteer-run service.
 */
export function DevRoutingExplorer() {
  const [destination, setDestination] = useState("Lisbon");
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [places, setPlaces] = useState<TripPlace[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [mode, setMode] = useState<RoutingMode | "auto">("walk");
  const [day, setDay] = useState<DayApiResponse["day"] | null>(null);
  const [selectedLegId, setSelectedLegId] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "geocode" | "discover" | "route">(null);
  const [error, setError] = useState<string | null>(null);
  /** How many times the route button has been pressed, to make caching visible. */
  const [routeRuns, setRouteRuns] = useState(0);
  const [lastRouteMs, setLastRouteMs] = useState<number | null>(null);

  /**
   * Synchronous re-entry guard. `busy` alone is not enough: React has not
   * re-rendered when a second click lands in the same tick, so the disabled
   * attribute would let a fast double-click through and spend two provider slots.
   */
  const inFlight = useRef(false);

  async function runGeocode() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("geocode");
    setError(null);
    setPlaces([]);
    setSelectedIds([]);
    setDay(null);
    try {
      const response = await fetch("/api/places/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destination }),
      });
      const json: unknown = await response.json();
      if (!response.ok) return setError(readApiError(json));

      const parsed = GeocodeResponseSchema.safeParse(json);
      if (!parsed.success) {
        return setError("The geocode response did not match the expected contract.");
      }
      setCandidate(parsed.data.candidates[0] ?? null);
      if (parsed.data.candidates.length === 0) setError("No matches for that name.");
    } catch {
      setError("Could not reach the geocode endpoint.");
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  async function runDiscover() {
    if (inFlight.current || !candidate) return;
    inFlight.current = true;
    setBusy("discover");
    setError(null);
    setDay(null);
    try {
      const response = await fetch("/api/places/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          center: { latitude: candidate.latitude, longitude: candidate.longitude },
          categories: [...DISCOVERY_CATEGORIES],
          radiusMeters: DISCOVERY_RADIUS_METERS,
          limitPerCategory: 8,
        }),
      });
      const json: unknown = await response.json();
      if (!response.ok) return setError(readApiError(json));

      const parsed = DiscoverResponseSchema.safeParse(json);
      if (!parsed.success) {
        return setError("The discover response did not match the expected contract.");
      }
      setPlaces(parsed.data.places);
      // Pre-select the first three, so the common case is one click away.
      setSelectedIds(parsed.data.places.slice(0, 3).map((place) => place.placeId));
    } catch {
      setError("Could not reach the discover endpoint.");
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  async function runRouting() {
    if (inFlight.current) return;
    const stops = orderedSelection(places, selectedIds);
    if (stops.length < 2) return;

    inFlight.current = true;
    setBusy("route");
    setError(null);
    const startedAt = performance.now();
    try {
      const response = await fetch("/api/routes/day", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dayNumber: 1,
          stops,
          ...(mode === "auto" ? {} : { mode }),
        }),
      });
      const json: unknown = await response.json();
      if (!response.ok) return setError(readApiError(json));

      const parsed = DayApiResponseSchema.safeParse(json);
      if (!parsed.success) {
        return setError("The routing response did not match the expected contract.");
      }
      setDay(parsed.data.day);
      setLastRouteMs(Math.round(performance.now() - startedAt));
      setRouteRuns((runs) => runs + 1);
    } catch {
      setError("Could not reach the routing endpoint.");
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  const stops = orderedSelection(places, selectedIds);

  const mapPlaces: VisibleMapPlace[] = stops.map((place, index) => ({
    itemId: place.placeId,
    placeId: place.placeId,
    sequenceNumber: index + 1,
    name: place.name,
    latitude: place.coordinates.lat,
    longitude: place.coordinates.lng,
    kind: "stop",
    dayNumber: 1,
  }));

  /**
   * Only routed legs become lines. An unavailable leg is deliberately absent —
   * there is nothing honest to draw for it, and the legend says so.
   */
  const routeLines: MapRouteLine[] = (day?.legs ?? []).flatMap((leg) =>
    leg.result.status === "routed"
      ? [
          {
            legId: leg.id,
            mode: leg.result.mode,
            coordinates: leg.result.geometry.coordinates,
            dayNumber: day?.dayNumber ?? null,
            selected: leg.id === selectedLegId,
          },
        ]
      : [],
  );

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 px-5 py-8 sm:px-8">
      <header className="flex flex-col gap-2">
        <span className="eyebrow text-terracotta">Development only</span>
        <h1 className="font-display text-3xl text-forest">Routing</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-ink-muted">
          Inspects the routing pipeline end to end: verified places in, real
          walking, driving and cycling geometry out. Routes come from a public
          Valhalla demo server over OpenStreetMap road data — <strong>not</strong>{" "}
          live traffic, and transit is not supported at all.
        </p>
      </header>

      {/* Step 1 — geocode + discover */}
      <section className="flex flex-col gap-3 rounded-2xl border border-line bg-cream-raised p-5">
        <h2 className="font-display text-lg text-forest">1 · Find some places</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-56 flex-col gap-1.5">
            <Label htmlFor="dev-routing-destination">Destination</Label>
            <Input
              id="dev-routing-destination"
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              placeholder="Lisbon"
            />
          </div>
          <Button
            type="button"
            onClick={runGeocode}
            disabled={busy !== null || destination.trim().length === 0}
            className="h-9 gap-1.5"
          >
            <Search aria-hidden className="size-3.5" />
            {busy === "geocode" ? "Searching…" : "Geocode"}
          </Button>
          <Button
            type="button"
            onClick={runDiscover}
            disabled={busy !== null || !candidate}
            className="h-9 gap-1.5"
            data-testid="discover-button"
          >
            <Database aria-hidden className="size-3.5" />
            {busy === "discover" ? "Discovering…" : "Discover places"}
          </Button>
        </div>
        {candidate ? (
          <p className="font-mono text-[0.6875rem] text-ink-muted" data-testid="geocode-match">
            {candidate.displayName} · {candidate.canonicalId}
          </p>
        ) : null}
      </section>

      {/* Step 2 — choose stops */}
      {places.length > 0 ? (
        <section className="flex flex-col gap-3 rounded-2xl border border-line bg-cream-raised p-5">
          <h2 className="font-display text-lg text-forest">
            2 · Choose stops, in order
          </h2>
          <p className="text-xs text-ink-muted">
            Click to add. The number is the visit order — routing never reorders
            stops, so the legs follow exactly this sequence.
          </p>
          <ul className="flex flex-wrap gap-1.5" data-testid="place-choices">
            {places.map((place) => {
              const position = selectedIds.indexOf(place.placeId);
              const active = position >= 0;
              return (
                <li key={place.placeId}>
                  <button
                    type="button"
                    aria-pressed={active}
                    data-place-id={place.placeId}
                    onClick={() =>
                      setSelectedIds((current) =>
                        current.includes(place.placeId)
                          ? current.filter((id) => id !== place.placeId)
                          : current.length >= 12
                            ? current
                            : [...current, place.placeId],
                      )
                    }
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs transition-colors",
                      active
                        ? "border-forest bg-forest text-primary-foreground"
                        : "border-line text-ink hover:border-forest-soft/60",
                    )}
                  >
                    {active ? `${position + 1} · ` : ""}
                    {place.name}
                    <span className="opacity-70"> ({placeCategoryLabel(place)})</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {/* Step 3 — mode and run */}
      {places.length > 0 ? (
        <section className="flex flex-col gap-3 rounded-2xl border border-line bg-cream-raised p-5">
          <h2 className="font-display text-lg text-forest">3 · Route it</h2>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-ink">Travel mode</legend>
            <div className="flex flex-wrap gap-1.5">
              {(["walk", "bicycle", "drive", "auto"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={mode === option}
                  data-mode={option}
                  onClick={() => setMode(option)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs transition-colors",
                    mode === option
                      ? "border-forest bg-forest text-primary-foreground"
                      : "border-line text-ink hover:border-forest-soft/60",
                  )}
                >
                  {option === "auto"
                    ? "Choose by distance"
                    : ROUTING_MODE_LABELS[option]}
                </button>
              ))}
            </div>
            {/*
             * Transit is absent from the control on purpose, and said out loud
             * rather than silently omitted — a reader should learn that it is
             * unsupported, not that we forgot it.
             */}
            <p className="text-[0.6875rem] text-ink-muted" data-testid="transit-note">
              Transit is not offered. No transit feed is loaded, and returning a
              walking or driving route under a transit label would be a lie about
              the journey.
            </p>
          </fieldset>

          <Button
            type="button"
            onClick={runRouting}
            disabled={busy !== null || stops.length < 2}
            className="h-9 w-fit gap-1.5"
            data-testid="route-button"
          >
            <Waypoints aria-hidden className="size-3.5" />
            {busy === "route" ? "Routing…" : `Route ${Math.max(0, stops.length - 1)} legs`}
          </Button>
          {stops.length < 2 ? (
            <p className="text-xs text-ink-muted">Choose at least two stops.</p>
          ) : null}
        </section>
      ) : null}

      {error ? (
        <p
          role="alert"
          data-testid="dev-error"
          className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/[0.06] px-3.5 py-2.5 text-sm text-ink"
        >
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
          {error}
        </p>
      ) : null}

      {day ? (
        <>
          <section
            className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-line bg-sand/40 p-4 text-xs"
            data-testid="routing-summary"
            data-routed={day.summary.routed}
            data-unavailable={day.summary.unavailable}
          >
            <span className="font-medium">
              {day.summary.routed}/{day.summary.total} legs routed
            </span>
            {day.summary.unavailable > 0 ? (
              <span className="font-medium text-terracotta">
                {day.summary.unavailable} unavailable
              </span>
            ) : null}
            <span className="text-ink-muted">
              {formatDistance(day.summary.routedDistanceMeters)} ·{" "}
              {formatDuration(
                durationSecondsToMinutes(day.summary.routedDurationSeconds),
              )}{" "}
              across routed legs
            </span>
            <span className="text-ink-muted" data-testid="route-timing">
              run {routeRuns} · {lastRouteMs ?? "–"} ms
            </span>
          </section>

          <Legend />

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,26rem)] lg:items-start">
            <ul className="flex flex-col gap-2" data-testid="routed-legs">
              {day.legs.map((leg) => (
                <li key={leg.id}>
                  <LegRow
                    leg={leg}
                    selected={leg.id === selectedLegId}
                    onSelect={() =>
                      setSelectedLegId((current) =>
                        current === leg.id ? null : leg.id,
                      )
                    }
                  />
                </li>
              ))}
            </ul>

            <div className="h-[32rem] lg:sticky lg:top-24">
              <MapPanel
                places={mapPlaces}
                routes={routeLines}
                selectedItemId={null}
                activeDayNumber="all"
                onSelectItem={() => {}}
                dayLabel={`${routeLines.length} routed of ${day.summary.total} legs`}
              />
            </div>
          </div>

          <p className="text-[0.6875rem] text-ink-muted" data-testid="routing-attribution">
            {day.attribution}
          </p>
        </>
      ) : null}
    </div>
  );
}

/**
 * The legend, which is load-bearing rather than decorative.
 *
 * Two lines on the map mean two different claims, and without this a reader
 * would reasonably assume the dashed one is a route too.
 */
function Legend() {
  return (
    <section
      className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-line bg-cream-raised p-4 text-xs"
      data-testid="map-legend"
    >
      <span className="inline-flex items-center gap-2">
        <svg aria-hidden width="34" height="8" viewBox="0 0 34 8">
          <line
            x1="1"
            y1="4"
            x2="33"
            y2="4"
            stroke="#2f4f3f"
            strokeOpacity="0.5"
            strokeWidth="2"
            strokeDasharray="4 3.2"
          />
        </svg>
        <span className="text-ink-muted">Itinerary order — not a route</span>
      </span>
      <span className="inline-flex items-center gap-2">
        <svg aria-hidden width="34" height="8" viewBox="0 0 34 8">
          <line x1="1" y1="4" x2="33" y2="4" stroke="#2f4f3f" strokeWidth="3.5" />
        </svg>
        <span className="text-ink-muted">Walking route</span>
      </span>
      <span className="inline-flex items-center gap-2">
        <svg aria-hidden width="34" height="8" viewBox="0 0 34 8">
          <line x1="1" y1="4" x2="33" y2="4" stroke="#b4552d" strokeWidth="3.5" />
        </svg>
        <span className="text-ink-muted">Driving route</span>
      </span>
      <span className="inline-flex items-center gap-2">
        <svg aria-hidden width="34" height="8" viewBox="0 0 34 8">
          <line x1="1" y1="4" x2="33" y2="4" stroke="#4a6d8c" strokeWidth="3.5" />
        </svg>
        <span className="text-ink-muted">Cycling route</span>
      </span>
      <span className="inline-flex items-center gap-2">
        <RouteOff aria-hidden className="size-3.5 text-ink-muted" />
        <span className="text-ink-muted">
          Unavailable — no line is drawn for a leg we could not route
        </span>
      </span>
    </section>
  );
}

function LegRow({
  leg,
  selected,
  onSelect,
}: {
  leg: DayApiResponse["day"]["legs"][number];
  selected: boolean;
  onSelect: () => void;
}) {
  const result = leg.result;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      data-leg-id={leg.id}
      data-leg-status={result.status}
      className={cn(
        "flex w-full flex-col gap-1.5 rounded-xl border p-3.5 text-left transition-colors",
        selected ? "border-forest bg-forest/[0.06]" : "border-line bg-cream-raised",
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ink">
          {result.status === "routed" ? (
            <ModeIcon mode={result.mode} />
          ) : (
            <RouteOff aria-hidden className="size-3.5 text-terracotta" />
          )}
          {result.status === "routed"
            ? `${formatDuration(
                durationSecondsToMinutes(result.durationSeconds),
              )} ${ROUTING_MODE_LABELS[result.mode].toLowerCase()}`
            : "Route unavailable"}
        </span>
        {result.status === "routed" ? (
          <span
            className="rounded-full bg-sand px-2 py-0.5 text-[0.6875rem] text-forest"
            data-testid="leg-distance"
          >
            {formatDistance(result.distanceMeters)}
          </span>
        ) : (
          <span className="rounded-full bg-terracotta/10 px-2 py-0.5 text-[0.6875rem] text-terracotta">
            {result.reason}
          </span>
        )}
      </div>

      <p className="font-mono text-[0.6875rem] break-all text-ink-muted">
        {leg.fromPlaceId} → {leg.toPlaceId}
      </p>

      {result.status === "routed" ? (
        <p className="text-[0.6875rem] text-ink-muted" data-testid="leg-provenance">
          {result.provider} · {result.geometry.coordinates.length} shape points ·
          straight line {formatDistance(leg.straightLineMeters)} · fetched{" "}
          {result.fetchedAt}
        </p>
      ) : (
        <p className="text-[0.6875rem] text-ink-muted">{result.userMessage}</p>
      )}
    </button>
  );
}

function ModeIcon({ mode }: { mode: RoutingMode }) {
  const Icon = MODE_ICONS[mode];
  return <Icon aria-hidden className="size-3.5 text-forest" />;
}

/** Selection order, not discovery order — the chips are numbered by it. */
function orderedSelection(places: TripPlace[], selectedIds: string[]): TripPlace[] {
  const byId = new Map(places.map((place) => [place.placeId, place]));
  return selectedIds.flatMap((id) => {
    const place = byId.get(id);
    return place ? [place] : [];
  });
}

function readApiError(json: unknown): string {
  if (
    json !== null &&
    typeof json === "object" &&
    "error" in json &&
    typeof (json as { error?: { message?: unknown } }).error?.message === "string"
  ) {
    return (json as { error: { message: string } }).error.message;
  }
  return "The request failed.";
}
