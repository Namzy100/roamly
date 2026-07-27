import { z } from "zod";

import { validatePlanMembership } from "@/lib/structural-edits";
import { TRIP_PLAN_SCHEMA_VERSION } from "@/lib/schemas";

import { EMPTY_HISTORY } from "./history";
import { TripRecordSchema, type StoredTripRecord } from "./trip-record";

/**
 * Exporting and importing a saved trip as JSON.
 *
 * ## Why this exists, and what it is not
 *
 * It is a **resilience** feature, not a planning one. Trips live in one browser and nowhere else,
 * so a full storage quota, a cleared site, a new laptop or a switched browser all lose them. Export
 * answers "I cannot afford to lose this"; import answers "I have it in a file".
 *
 * It is not sharing, not sync, not collaboration, and not a wire format anyone else consumes.
 *
 * ## Import treats the file as hostile data
 *
 * A downloaded JSON file is untrusted input, and this is the one path where a traveller hands us a
 * whole `TripPlan` rather than a `placeId`. So it is parsed as **data only** and then put through
 * the same gates a generated plan passes:
 *
 *  - `TripPlanSchema` and `TripGenerationContextSchema`, via the record envelope — every field,
 *    every bound
 *  - `validatePlanMembership` — every attached place resolves to the active pool or to a recorded
 *    retained place the plan uses, and each attached copy is faithful to the pool's
 *  - version **equality**, not "at least": a file from a newer build may describe a shape this
 *    build cannot render
 *
 * Nothing is executed, nothing is interpreted as markup, and no field is trusted because it was
 * present. In particular the import path cannot widen the pool invariant, because it runs the same
 * assertion generation does.
 *
 * ## What never leaves
 *
 * No model prompt, no raw provider response, no key, no transient workflow state — none of which is
 * in the stored record in the first place. That is what makes "export the record" safe: it is a copy
 * of what `localStorage` already holds, not a new assembly with new access.
 */

/**
 * Bumped only when the *document wrapper* changes.
 *
 * Independent of `TRIP_PLAN_SCHEMA_VERSION`: the wrapper could gain a field while the plan shape
 * stays put, and conflating the two would reject files that are perfectly readable.
 */
export const PORTABLE_TRIP_FORMAT = 1;

/** A hint, not a licence. The importer checks the payload regardless of what this claims. */
const FORMAT_LABEL = "roamly.trip";

export const PortableTripSchema = z.object({
  format: z.literal(FORMAT_LABEL),
  formatVersion: z.literal(PORTABLE_TRIP_FORMAT),
  exportedAt: z.string().min(1),
  planSchemaVersion: z.literal(TRIP_PLAN_SCHEMA_VERSION),
  record: TripRecordSchema,
});
export type PortableTrip = z.infer<typeof PortableTripSchema>;

/**
 * A record, ready to write to a file.
 *
 * Re-parsed on the way out, so a record corrupted in memory cannot become a file that looks valid —
 * and so key order is normalised, which is what makes two exports of one trip byte-identical.
 */
export function exportTrip(
  record: StoredTripRecord,
  exportedAt: string,
): PortableTrip {
  return {
    format: FORMAT_LABEL,
    formatVersion: PORTABLE_TRIP_FORMAT,
    exportedAt,
    planSchemaVersion: TRIP_PLAN_SCHEMA_VERSION,
    record: TripRecordSchema.parse(record),
  };
}

/** Indented, because a file a person can open and sanity-check is worth more than a compact one. */
export function serialiseTrip(trip: PortableTrip): string {
  return `${JSON.stringify(trip, null, 2)}\n`;
}

/** A filename a person can recognise a month later. */
export function exportFileName(record: StoredTripRecord): string {
  const slug = record.plan.destination.city
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return `roamly-${slug || "trip"}-${record.plan.request.startDate}.json`;
}

export type ImportFailureCode =
  | "not_json"
  | "not_a_roamly_trip"
  | "unsupported_version"
  | "invalid_record"
  | "pool_violation"
  | "too_large";

export type ImportResult =
  | { ok: true; trip: PortableTrip }
  | { ok: false; code: ImportFailureCode; message: string };

/**
 * A ceiling applied before `JSON.parse` sees the text.
 *
 * A record is ~150 KB and the schema caps the pool at 150 places, so 4 MB is far above anything this
 * app writes. The point is that a hostile 500 MB file must not be parsed at all — the bound makes
 * the work finite by construction rather than by trusting the schema to reject it afterwards.
 */
export const MAX_IMPORT_BYTES = 4 * 1024 * 1024;

export function parseImportedTrip(text: string): ImportResult {
  /**
   * A secondary bound, measured in UTF-16 code units rather than bytes.
   *
   * The primary check is `file.size` at the caller, which is the real byte count and needs no read.
   * This one is deliberately kept as well — `parseImportedTrip` is also reachable from tests and from
   * any future non-file caller — and it errs loose for multi-byte text rather than tight, which is why
   * it is the backstop and not the gate.
   */
  if (text.length > MAX_IMPORT_BYTES) {
    return {
      ok: false,
      code: "too_large",
      message:
        "That file is far larger than any Roamly trip, so it was not read. Check you selected the right file.",
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      ok: false,
      code: "not_json",
      message: "That file is not valid JSON, so nothing was imported.",
    };
  }

  /**
   * The label and version are checked before the record, so a file from another tool or a newer
   * build produces a message about *that* rather than a wall of field errors.
   */
  const envelope = z
    .object({ format: z.string().optional(), formatVersion: z.number().optional() })
    .safeParse(raw);

  if (!envelope.success || envelope.data.format !== FORMAT_LABEL) {
    return {
      ok: false,
      code: "not_a_roamly_trip",
      message:
        "That file is not a Roamly trip export, so nothing was imported. Exported trips begin with a Roamly format marker.",
    };
  }

  if (envelope.data.formatVersion !== PORTABLE_TRIP_FORMAT) {
    return {
      ok: false,
      code: "unsupported_version",
      message: `That file was written in export format ${envelope.data.formatVersion ?? "unknown"}; this version of Roamly reads format ${PORTABLE_TRIP_FORMAT}. Nothing was imported.`,
    };
  }

  const parsed = PortableTripSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      code: "invalid_record",
      message: `That trip did not pass validation, so nothing was imported: ${issue?.path.join(".") || "record"} — ${issue?.message ?? "unrecognised shape"}.`,
    };
  }

  /**
   * The membership gate, run on imported data exactly as on generated data.
   *
   * This is what stops an edited file introducing a place no search ever found, a retained entry
   * nothing references, or a place claiming to be both current and retained. Without it, "import"
   * would be a way around the invariant the architecture rests on.
   */
  const record = parsed.data.record;
  if (record.generation) {
    const issues = validatePlanMembership({
      plan: record.plan,
      generation: record.generation,
    });
    if (issues.length > 0) {
      return {
        ok: false,
        code: "pool_violation",
        message: `That trip's places did not pass verification, so nothing was imported: ${issues[0].message}`,
      };
    }
  }

  return { ok: true, trip: parsed.data };
}

/**
 * The record to store when importing as a **new copy**.
 *
 * ## Provenance preserved; authorship not claimed
 *
 * The plan keeps its `source`, its places keep their OpenStreetMap identity and attribution, and the
 * context keeps the provider, model and timestamp that actually produced it. An imported Gemini trip
 * still says Gemini, because that is what happened.
 *
 * What changes is what a *copy* means: a new trip id, `createdAt`/`updatedAt` at the import time,
 * revision reset to 1, and the undo snapshot dropped. Dropping it is deliberate — it would let
 * "undo" walk a copy back to a state the copy never had, and it is the largest part of the record.
 */
export function asImportedCopy(
  trip: PortableTrip,
  tripId: string,
  now: string,
): StoredTripRecord {
  return {
    revision: 1,
    createdAt: now,
    updatedAt: now,
    plan: { ...trip.record.plan, id: tripId },
    generation: trip.record.generation,
    /** A copy starts fresh: the original's history describes edits to a trip this one is not. */
    history: EMPTY_HISTORY,
  };
}
