"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, Loader2, Sparkles, Wand2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";

import { Field, FieldSet } from "@/components/form/field";
import { ChipGroup, RadioCardGroup } from "@/components/form/choice-group";
import { TripGenerationPanel } from "@/components/form/trip-generation-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useTripGeneration } from "@/lib/hooks/use-trip-generation";
import { mockTripRequest } from "@/lib/mock/lisbon-trip";
import {
  ACCOMMODATION_OPTIONS,
  CURRENCY_OPTIONS,
  DIETARY_OPTIONS,
  INTEREST_OPTIONS,
  MAX_TRIP_DAYS,
  PACE_OPTIONS,
  TripRequestSchema,
  VIBE_OPTIONS,
  type TripRequest,
} from "@/lib/schemas";
import {
  offlineReasonFor,
  useOnlineStatus,
} from "@/lib/hooks/use-online-status";
import { STORAGE_FAILURE_MESSAGES } from "@/lib/store/storage-usage";
import { useTripStore } from "@/lib/store/trip-store";
import { useTripStoreHydration } from "@/lib/store/use-hydration";
import { cn } from "@/lib/utils";

/**
 * Empty rather than date-seeded defaults.
 *
 * Deriving default dates from `new Date()` would produce different values on the
 * server and the client and break hydration. The "sample trip" button fills the
 * form instead, which keeps the deterministic-mock guarantee intact.
 */
const EMPTY_DEFAULTS: TripRequest = {
  departureCity: "",
  destination: "",
  startDate: "",
  endDate: "",
  budget: 3200,
  currency: "EUR",
  travelers: 2,
  vibes: [],
  pace: "balanced",
  accommodation: "boutique",
  dietary: [],
  interests: [],
  notes: "",
};

export function TripBuilderForm() {
  const router = useRouter();
  const createTrip = useTripStore((state) => state.createTrip);
  const online = useOnlineStatus();
  const [sampleRefused, setSampleRefused] = useState(false);
  const lastRequest = useTripStore((state) => state.lastRequest);
  const hydrated = useTripStoreHydration();

  /**
   * Submission is now two steps, and the form owns neither of them.
   *
   * Phase 1 built the sample plan synchronously in a click handler. Real generation
   * needs a destination resolved and confirmed first, then a multi-second server
   * round trip with progress and a cancel — so the state machine lives in
   * `useTripGeneration` and this component renders it.
   */
  const {
    phase,
    availability,
    resolveDestination,
    selectDestination,
    generate,
    cancel,
    reset: resetGeneration,
  } = useTripGeneration();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<TripRequest>({
    resolver: zodResolver(TripRequestSchema),
    defaultValues: EMPTY_DEFAULTS,
    mode: "onBlur",
  });

  // Returning visitors get their previous answers back. Applied after hydration
  // so the first client render still matches the server's empty form.
  useEffect(() => {
    if (hydrated && lastRequest) {
      reset(lastRequest, { keepDefaultValues: true });
    }
  }, [hydrated, lastRequest, reset]);

  // Navigation happens on completion rather than inside the hook, so the hook stays
  // free of routing and can be reasoned about — and tested — as pure state.
  useEffect(() => {
    if (phase.status === "done") router.push(`/trip/${phase.tripId}`);
  }, [phase, router]);

  const onSubmit = handleSubmit((values) => {
    void resolveDestination(values);
  });

  const busy = phase.status === "geocoding" || phase.status === "generating";
  const selectedDestination =
    phase.status === "choosing" ? phase.selected : null;

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="flex flex-col gap-8 rounded-3xl border border-line bg-cream-raised p-6 shadow-card sm:p-8 lg:p-10"
      aria-labelledby="builder-heading"
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="eyebrow text-terracotta">Trip builder</span>
          <h2
            id="builder-heading"
            className="font-display text-2xl text-forest sm:text-3xl"
          >
            Tell us the shape of the trip
          </h2>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => reset(mockTripRequest)}
          className="h-9 gap-1.5 px-3"
        >
          <Wand2 aria-hidden className="size-3.5" />
          Use the sample trip
        </Button>
      </div>

      {/* Route */}
      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          id="departureCity"
          label="Flying from"
          error={errors.departureCity?.message}
        >
          <Input
            id="departureCity"
            placeholder="Dubai"
            autoComplete="address-level2"
            aria-invalid={Boolean(errors.departureCity)}
            {...register("departureCity")}
          />
        </Field>

        <Field
          id="destination"
          label="Going to"
          error={errors.destination?.message}
        >
          <Input
            id="destination"
            placeholder="Lisbon"
            autoComplete="off"
            aria-invalid={Boolean(errors.destination)}
            {...register("destination")}
          />
        </Field>
      </div>

      {/* Dates */}
      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          id="startDate"
          label="Departure date"
          error={errors.startDate?.message}
        >
          <Input
            id="startDate"
            type="date"
            aria-invalid={Boolean(errors.startDate)}
            {...register("startDate")}
          />
        </Field>

        <Field
          id="endDate"
          label="Return date"
          hint={`Up to ${MAX_TRIP_DAYS} days for now`}
          error={errors.endDate?.message}
        >
          <Input
            id="endDate"
            type="date"
            aria-invalid={Boolean(errors.endDate)}
            {...register("endDate")}
          />
        </Field>
      </div>

      {/* Budget */}
      <div className="grid gap-5 sm:grid-cols-3">
        <Field
          id="budget"
          label="Total budget"
          hint="For the whole party"
          error={errors.budget?.message}
        >
          <Input
            id="budget"
            type="number"
            inputMode="numeric"
            min={1}
            step={50}
            aria-invalid={Boolean(errors.budget)}
            {...register("budget", { valueAsNumber: true })}
          />
        </Field>

        <Field id="currency" label="Currency" error={errors.currency?.message}>
          <select
            id="currency"
            aria-invalid={Boolean(errors.currency)}
            className={cn(
              "h-9 w-full rounded-lg border border-input bg-cream-raised px-3 text-sm text-ink",
              "focus-visible:border-ring",
            )}
            {...register("currency")}
          >
            {CURRENCY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        <Field
          id="travelers"
          label="Travellers"
          error={errors.travelers?.message}
        >
          <Input
            id="travelers"
            type="number"
            inputMode="numeric"
            min={1}
            max={12}
            aria-invalid={Boolean(errors.travelers)}
            {...register("travelers", { valueAsNumber: true })}
          />
        </Field>
      </div>

      <hr className="border-line" />

      <FieldSet
        legend="Vibes"
        hint="Pick one to four — this drives the shape of each day."
        error={errors.vibes?.message}
      >
        <ChipGroup
          options={VIBE_OPTIONS}
          registration={register("vibes")}
          idPrefix="vibe"
        />
      </FieldSet>

      <FieldSet legend="Pace" error={errors.pace?.message}>
        <RadioCardGroup
          options={PACE_OPTIONS}
          registration={register("pace")}
          idPrefix="pace"
          columns={3}
        />
      </FieldSet>

      <FieldSet legend="Where you'd like to stay" error={errors.accommodation?.message}>
        <RadioCardGroup
          options={ACCOMMODATION_OPTIONS}
          registration={register("accommodation")}
          idPrefix="stay"
          columns={5}
        />
      </FieldSet>

      <FieldSet
        legend="Dietary preferences"
        hint="Optional. Restaurant picks will respect these."
        error={errors.dietary?.message}
      >
        <ChipGroup
          options={DIETARY_OPTIONS}
          registration={register("dietary")}
          idPrefix="diet"
        />
      </FieldSet>

      <FieldSet
        legend="Interests"
        hint="Pick up to eight. The more specific, the better the plan."
        error={errors.interests?.message}
      >
        <ChipGroup
          options={INTEREST_OPTIONS}
          registration={register("interests")}
          idPrefix="interest"
        />
      </FieldSet>

      <Field
        id="notes"
        label="Anything else?"
        hint="Mobility needs, an anniversary, a place you already booked — anything that should shape the plan."
        error={errors.notes?.message}
      >
        <Textarea
          id="notes"
          rows={4}
          placeholder="First time in Portugal. We'd rather go deep on a few neighbourhoods than tick off a list."
          aria-invalid={Boolean(errors.notes)}
          {...register("notes")}
        />
      </Field>

      <div className="flex flex-col gap-3 border-t border-line pt-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-2 text-xs text-ink-muted">
          <Sparkles aria-hidden className="size-3.5 text-terracotta" />
          {online
            ? "Places come from OpenStreetMap. Prices are planning estimates, never live."
            : offlineReasonFor("geocode")}
        </p>
        <Button
          type="submit"
          size="lg"
          /**
           * Disabled offline rather than allowed to fail.
           *
           * Confirming a destination is a geocoder request, and starting one with no network gives a
           * traveller a spinner and then an error that tells them nothing they did not already know.
           * The reason is stated beside the button, so the disabled state is never unexplained.
           */
          disabled={busy || !online}
          data-testid="find-destination"
          className="h-12 w-full gap-2 rounded-full px-7 text-base sm:w-auto"
        >
          {busy ? (
            <>
              <Loader2 aria-hidden className="size-4 animate-spin" />
              Working…
            </>
          ) : (
            <>
              Find my destination
              <ArrowRight aria-hidden className="size-4" />
            </>
          )}
        </Button>
      </div>

      <TripGenerationPanel
        phase={phase}
        availability={availability}
        onSelectDestination={selectDestination}
        onGenerate={(preference) => {
          if (!selectedDestination) return;
          void generate({
            destination: selectedDestination,
            providerPreference: preference,
          });
        }}
        onCancel={cancel}
        onBack={resetGeneration}
      />

      {/*
       * The fixed Lisbon sample, kept as an explicit escape hatch.
       *
       * It needs no network at all, which makes it the one thing that always works —
       * useful for a visitor who wants to see the workspace before committing to a
       * real generation, and useful when every external service is down.
       */}
      {phase.status === "idle" ? (
        <button
          type="button"
          onClick={() => {
            /**
             * `null` means the browser had no room, so there is nothing to navigate to.
             *
             * Navigating anyway would land on a trip page whose record was never written — the
             * "looks saved, is not" failure the capacity pre-flight exists to prevent.
             */
            const tripId = createTrip(mockTripRequest);
            if (tripId === null) {
              setSampleRefused(true);
              return;
            }
            router.push(`/trip/${tripId}`);
          }}
          data-testid="open-sample-trip"
          className="w-fit text-xs text-ink-muted underline underline-offset-2 hover:text-forest"
        >
          Or open the fixed Lisbon sample itinerary, with no searches at all
        </button>
      ) : null}

      {sampleRefused ? (
        <p
          role="alert"
          data-testid="sample-storage-refused"
          className="text-xs leading-relaxed text-ink"
        >
          {STORAGE_FAILURE_MESSAGES.quota_exceeded}
        </p>
      ) : null}
    </form>
  );
}
