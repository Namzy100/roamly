"use client";

import { AlertTriangle, CheckCircle2, Database, Search } from "lucide-react";
import { useRef, useState } from "react";

import { MapPanel } from "@/components/map/map-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DiscoverResponseSchema,
  GeocodeResponseSchema,
  type DiscoverResponse,
  type GeocodeResponse,
} from "@/lib/api/places-contract";
import type { VisibleMapPlace } from "@/lib/map/types";
import {
  PLACE_CATEGORY_LABELS,
  PlaceCategorySchema,
  placeCategoryLabel,
  type PlaceCategory,
  type TripPlace,
} from "@/lib/schemas/place";
import { cn } from "@/lib/utils";

type Candidate = GeocodeResponse["candidates"][number];

const DEFAULT_CATEGORIES: PlaceCategory[] = ["museum", "cafe", "viewpoint"];
const RADIUS_OPTIONS = [500, 1_000, 2_000, 3_000, 5_000] as const;

/**
 * Dev-only explorer for the provider pipeline.
 *
 * Two explicit submits, never search-as-you-type: Nominatim's usage policy forbids
 * per-keystroke querying, and a limiter alone would only queue the abuse rather than
 * prevent it. Nothing fires on render, on mount, or on field change.
 */
export function DevPlacesExplorer() {
  const [destination, setDestination] = useState("Lisbon");
  const [geocode, setGeocode] = useState<GeocodeResponse | null>(null);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [categories, setCategories] = useState<PlaceCategory[]>(DEFAULT_CATEGORIES);
  const [radius, setRadius] = useState<number>(2_000);
  const [discovery, setDiscovery] = useState<DiscoverResponse | null>(null);
  const [busy, setBusy] = useState<null | "geocode" | "discover">(null);
  const [error, setError] = useState<string | null>(null);
  /** Synchronous re-entry guard; see the note in `runGeocode`. */
  const inFlight = useRef(false);

  async function runGeocode() {
    // Guard on the ref, not on `busy`: React has not re-rendered yet when a second
    // click arrives in the same tick, so the disabled attribute alone would let a
    // fast double-click through and spend two of the limiter's slots.
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("geocode");
    setError(null);
    setDiscovery(null);
    setSelected(null);
    try {
      const response = await fetch("/api/places/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destination }),
      });
      const json: unknown = await response.json();
      if (!response.ok) {
        setError(readApiError(json));
        setGeocode(null);
        return;
      }
      const parsed = GeocodeResponseSchema.safeParse(json);
      if (!parsed.success) {
        setError("The geocode response did not match the expected contract.");
        return;
      }
      setGeocode(parsed.data);
      if (parsed.data.candidates.length === 1) {
        setSelected(parsed.data.candidates[0]);
      }
    } catch {
      setError("Could not reach the geocode endpoint.");
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  async function runDiscover(candidate: Candidate) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("discover");
    setError(null);
    try {
      const response = await fetch("/api/places/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          center: {
            latitude: candidate.latitude,
            longitude: candidate.longitude,
          },
          categories,
          radiusMeters: radius,
          limitPerCategory: 15,
        }),
      });
      const json: unknown = await response.json();
      if (!response.ok) {
        setError(readApiError(json));
        setDiscovery(null);
        return;
      }
      const parsed = DiscoverResponseSchema.safeParse(json);
      if (!parsed.success) {
        setError("The discover response did not match the expected contract.");
        return;
      }
      setDiscovery(parsed.data);
    } catch {
      setError("Could not reach the discover endpoint.");
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  const mapPlaces: VisibleMapPlace[] = (discovery?.places ?? []).map(
    (place, index) => ({
      itemId: place.placeId,
      placeId: place.placeId,
      sequenceNumber: index + 1,
      name: place.name,
      latitude: place.coordinates.lat,
      longitude: place.coordinates.lng,
      kind: "stop",
      dayNumber: 1,
    }),
  );

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 px-5 py-8 sm:px-8">
      <header className="flex flex-col gap-2">
        <span className="eyebrow text-terracotta">Development only</span>
        <h1 className="font-display text-3xl text-forest">Place discovery</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-ink-muted">
          Inspects the OpenStreetMap provider pipeline end to end. Both steps
          require an explicit submit — there is no search-as-you-type, because
          Nominatim&apos;s usage policy prohibits it.
        </p>
      </header>

      {/* Step 1 — geocode */}
      <section className="flex flex-col gap-3 rounded-2xl border border-line bg-cream-raised p-5">
        <h2 className="font-display text-lg text-forest">1 · Geocode a destination</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-56 flex-col gap-1.5">
            <Label htmlFor="dev-destination">Destination</Label>
            <Input
              id="dev-destination"
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
        </div>

        {geocode ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-ink-muted" data-testid="geocode-cache-state">
              {geocode.candidates.length} candidate
              {geocode.candidates.length === 1 ? "" : "s"} ·{" "}
              <span data-cache={geocode.fromCache ? "hit" : "miss"}>
                {geocode.fromCache ? "served from cache" : "fresh from provider"}
              </span>
            </p>
            <ul className="flex flex-col gap-1.5" data-testid="geocode-candidates">
              {geocode.candidates.map((candidate) => (
                <li key={candidate.canonicalId}>
                  <button
                    type="button"
                    onClick={() => setSelected(candidate)}
                    aria-pressed={selected?.canonicalId === candidate.canonicalId}
                    data-canonical-id={candidate.canonicalId}
                    className={cn(
                      "w-full rounded-xl border px-3.5 py-2.5 text-left text-sm transition-colors",
                      selected?.canonicalId === candidate.canonicalId
                        ? "border-forest bg-forest/[0.06]"
                        : "border-line hover:border-forest-soft/60",
                    )}
                  >
                    <span className="block font-medium text-ink">
                      {candidate.displayName}
                    </span>
                    <span className="block font-mono text-[0.6875rem] text-ink-muted">
                      {candidate.canonicalId} · {candidate.latitude.toFixed(5)},{" "}
                      {candidate.longitude.toFixed(5)}
                      {candidate.countryCode ? ` · ${candidate.countryCode}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="text-[0.6875rem] text-ink-muted">{geocode.attribution}</p>
          </div>
        ) : null}
      </section>

      {/* Step 2 — discover */}
      <section className="flex flex-col gap-3 rounded-2xl border border-line bg-cream-raised p-5">
        <h2 className="font-display text-lg text-forest">2 · Discover places</h2>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-ink">
            Categories (allowlisted)
          </legend>
          <div className="flex flex-wrap gap-1.5">
            {PlaceCategorySchema.options.map((category) => {
              const active = categories.includes(category);
              return (
                <button
                  key={category}
                  type="button"
                  aria-pressed={active}
                  onClick={() =>
                    setCategories((current) =>
                      current.includes(category)
                        ? current.filter((entry) => entry !== category)
                        : current.length >= 8
                          ? current
                          : [...current, category],
                    )
                  }
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs transition-colors",
                    active
                      ? "border-forest bg-forest text-primary-foreground"
                      : "border-line text-ink hover:border-forest-soft/60",
                  )}
                >
                  {PLACE_CATEGORY_LABELS[category]}
                </button>
              );
            })}
          </div>
          <p className="text-[0.6875rem] text-ink-muted">
            Maximum 8 per request. {categories.length} selected.
          </p>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-ink">Radius</legend>
          <div className="flex flex-wrap gap-1.5">
            {RADIUS_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={radius === option}
                onClick={() => setRadius(option)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition-colors",
                  radius === option
                    ? "border-forest bg-forest text-primary-foreground"
                    : "border-line text-ink hover:border-forest-soft/60",
                )}
              >
                {option < 1000 ? `${option} m` : `${option / 1000} km`}
              </button>
            ))}
          </div>
        </fieldset>

        <Button
          type="button"
          onClick={() => selected && runDiscover(selected)}
          disabled={busy !== null || !selected || categories.length === 0}
          className="h-9 w-fit gap-1.5"
        >
          <Database aria-hidden className="size-3.5" />
          {busy === "discover" ? "Discovering…" : "Run discovery"}
        </Button>
        {!selected ? (
          <p className="text-xs text-ink-muted">
            Choose a geocoding match above first.
          </p>
        ) : null}
      </section>

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

      {discovery ? (
        <DiscoveryResults discovery={discovery} mapPlaces={mapPlaces} />
      ) : null}
    </div>
  );
}

function DiscoveryResults({
  discovery,
  mapPlaces,
}: {
  discovery: DiscoverResponse;
  mapPlaces: VisibleMapPlace[];
}) {
  return (
    <>
      <section
        className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-line bg-sand/40 p-4 text-xs"
        data-testid="discovery-summary"
      >
        <span
          className="inline-flex items-center gap-1.5 font-medium"
          data-testid="pool-status"
          data-pool-valid={discovery.pool.valid ? "true" : "false"}
        >
          {discovery.pool.valid ? (
            <CheckCircle2 aria-hidden className="size-3.5 text-forest" />
          ) : (
            <AlertTriangle aria-hidden className="size-3.5 text-destructive" />
          )}
          Pool {discovery.pool.valid ? "validates" : "INVALID"} ·{" "}
          {discovery.pool.placeCount} places
        </span>
        <span className="text-ink-muted">
          {discovery.fromCache ? "served from cache" : "fresh from provider"}
        </span>
        <span className="text-ink-muted">
          radius {discovery.query.radiusMeters} m
        </span>
        <span className="text-ink-muted">
          discarded {discovery.discarded.total} (no category{" "}
          {discovery.discarded.noCategory}, no name {discovery.discarded.noName}, no
          coords {discovery.discarded.noCoordinates})
        </span>
        {discovery.query.categoriesWithNoResults.length > 0 ? (
          <span className="text-ink-muted">
            empty: {discovery.query.categoriesWithNoResults.join(", ")}
          </span>
        ) : null}
      </section>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,26rem)] lg:items-start">
        <ul className="flex flex-col gap-2" data-testid="discovered-places">
          {discovery.places.map((place) => (
            <li key={place.placeId}>
              <PlaceRow place={place} />
            </li>
          ))}
          {discovery.places.length === 0 ? (
            <li className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-ink-muted">
              No places matched. Try a wider radius or more categories.
            </li>
          ) : null}
        </ul>

        <div className="h-[28rem] lg:sticky lg:top-24">
          <MapPanel
            places={mapPlaces}
            selectedItemId={null}
            activeDayNumber="all"
            onSelectItem={() => {}}
            dayLabel={`${mapPlaces.length} discovered places`}
          />
        </div>
      </div>

      <p className="text-[0.6875rem] text-ink-muted" data-testid="attribution">
        {discovery.attribution}
      </p>
    </>
  );
}

/**
 * One discovered place, showing present *and* absent metadata.
 *
 * Absent fields are listed explicitly as "unknown" rather than hidden. The whole
 * point of this surface is to make missing provider data visible, so nobody later
 * assumes a gap was filled.
 */
function PlaceRow({ place }: { place: TripPlace }) {
  const optional: { label: string; value: string | undefined }[] = [
    { label: "address", value: place.address },
    { label: "website", value: place.website },
    { label: "phone", value: place.phone },
    { label: "cuisine", value: place.cuisine?.join(", ") },
    { label: "opening_hours", value: place.openingHours },
    { label: "wheelchair", value: place.wheelchair },
  ];

  return (
    <div
      className="flex flex-col gap-1.5 rounded-xl border border-line bg-cream-raised p-3.5"
      data-place-id={place.placeId}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-ink">{place.name}</span>
        <span className="rounded-full bg-sand px-2 py-0.5 text-[0.6875rem] text-forest">
          {placeCategoryLabel(place)}
        </span>
      </div>

      <p
        className="font-mono text-[0.6875rem] break-all text-ink-muted"
        data-testid="canonical-id"
      >
        {place.placeId} · {place.source.provider} · {place.source.osmType}/
        {place.source.osmId}
      </p>

      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-[0.6875rem]">
        {optional.map((field) => (
          <div key={field.label} className="flex gap-1">
            <dt className="text-ink-muted">{field.label}:</dt>
            <dd
              className={field.value ? "text-ink" : "text-ink-muted italic"}
              data-missing={field.value ? "false" : "true"}
            >
              {field.value ?? "unknown"}
            </dd>
          </div>
        ))}
      </dl>

      {/*
       * These three are never present on OSM records. Shown as explicitly absent so
       * the "no fabricated ratings or prices" rule is visible, not just asserted.
       */}
      <p className="text-[0.6875rem] text-ink-muted italic" data-testid="no-fabrication">
        rating: {place.rating ?? "not provided"} · reviews:{" "}
        {place.userRatingCount ?? "not provided"} · price:{" "}
        {place.priceLevel ?? "not provided"}
      </p>
    </div>
  );
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
