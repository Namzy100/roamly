/**
 * Which timezone a destination is in, and what a local wall-clock time means there.
 *
 * ## Why this is a curated table rather than a lookup
 *
 * Evaluating opening hours needs an IANA timezone. Nominatim does not supply one, and
 * the options for getting one are: a paid API (excluded), a network lookup on every
 * evaluation (excluded), a large bundled coordinate-to-timezone dataset (megabytes of
 * polygons for a feature this size), or a curated table.
 *
 * The table it is. It is honest about its own coverage: a country with a single
 * timezone resolves from the country code, a country with several resolves **only** if a
 * city matches, and anything else returns `null`. That produces `unknown_timezone`,
 * which is a truthful answer — far better than picking a country's most populous zone
 * and being an hour out for a third of its territory.
 *
 * ## What is never done
 *
 * The device's timezone is never consulted. A traveller in Sydney planning Lisbon must
 * get Lisbon's answer, and `new Date().getTimezoneOffset()` would silently give them
 * Sydney's. There is no code path here that reads the local zone.
 *
 * DST comes from `Intl.DateTimeFormat` with `timeZoneName: "longOffset"` — the platform's
 * own IANA database, which is maintained, correct across historical transitions, and
 * needs no dependency.
 */

export type TimezoneResolution = {
  timezone: string;
  /** How we knew. Recorded so a plan can say why its answer is what it is. */
  source: "city" | "country";
};

/**
 * Countries with more than one timezone.
 *
 * For these, the country code alone is not an answer, and returning one would be
 * inventing precision. A city match is required.
 */
const MULTI_TIMEZONE_COUNTRIES = new Set([
  "us", "ca", "ru", "au", "br", "mx", "id", "kz", "cd", "mn", "cl", "ec", "es",
  "pt", "fr", "nl", "dk", "gb", "cn", "in", "ar", "gl", "ki", "pf", "um", "nz",
  "za",
]);

/**
 * City overrides, keyed by lower-case name.
 *
 * Deliberately small: the supported demo destinations, plus the cities where getting
 * this wrong is most likely. Every entry is a place someone might plausibly plan a trip
 * to and where the country code is insufficient or misleading — Lisbon and Cape Town
 * both sit in countries with more than one zone.
 */
const CITY_TIMEZONES: Record<string, string> = {
  lisbon: "Europe/Lisbon",
  lisboa: "Europe/Lisbon",
  porto: "Europe/Lisbon",
  funchal: "Atlantic/Madeira",
  dubai: "Asia/Dubai",
  "abu dhabi": "Asia/Dubai",
  "cape town": "Africa/Johannesburg",
  kaapstad: "Africa/Johannesburg",
  johannesburg: "Africa/Johannesburg",
  athens: "Europe/Athens",
  athina: "Europe/Athens",
  thessaloniki: "Europe/Athens",
  barcelona: "Europe/Madrid",
  madrid: "Europe/Madrid",
  seville: "Europe/Madrid",
  sevilla: "Europe/Madrid",
  "las palmas": "Atlantic/Canary",
  paris: "Europe/Paris",
  lyon: "Europe/Paris",
  marseille: "Europe/Paris",
  amsterdam: "Europe/Amsterdam",
  london: "Europe/London",
  edinburgh: "Europe/London",
  manchester: "Europe/London",
  "new york": "America/New_York",
  boston: "America/New_York",
  chicago: "America/Chicago",
  denver: "America/Denver",
  "los angeles": "America/Los_Angeles",
  "san francisco": "America/Los_Angeles",
  seattle: "America/Los_Angeles",
  toronto: "America/Toronto",
  vancouver: "America/Vancouver",
  "mexico city": "America/Mexico_City",
  "sao paulo": "America/Sao_Paulo",
  "são paulo" : "America/Sao_Paulo",
  "rio de janeiro": "America/Sao_Paulo",
  "buenos aires": "America/Argentina/Buenos_Aires",
  santiago: "America/Santiago",
  sydney: "Australia/Sydney",
  melbourne: "Australia/Melbourne",
  brisbane: "Australia/Brisbane",
  perth: "Australia/Perth",
  auckland: "Pacific/Auckland",
  moscow: "Europe/Moscow",
  "saint petersburg": "Europe/Moscow",
  beijing: "Asia/Shanghai",
  shanghai: "Asia/Shanghai",
  "hong kong": "Asia/Hong_Kong",
  delhi: "Asia/Kolkata",
  "new delhi": "Asia/Kolkata",
  mumbai: "Asia/Kolkata",
  copenhagen: "Europe/Copenhagen",
  "cape verde": "Atlantic/Cape_Verde",
};

/**
 * Single-timezone countries.
 *
 * Not exhaustive by design — an absent country returns `null` and the traveller is told
 * the timezone is unknown, which is the correct answer for a table that does not claim
 * to be a geography service.
 */
const COUNTRY_TIMEZONES: Record<string, string> = {
  it: "Europe/Rome",
  de: "Europe/Berlin",
  at: "Europe/Vienna",
  ch: "Europe/Zurich",
  be: "Europe/Brussels",
  lu: "Europe/Luxembourg",
  ie: "Europe/Dublin",
  se: "Europe/Stockholm",
  no: "Europe/Oslo",
  fi: "Europe/Helsinki",
  pl: "Europe/Warsaw",
  cz: "Europe/Prague",
  sk: "Europe/Bratislava",
  hu: "Europe/Budapest",
  hr: "Europe/Zagreb",
  si: "Europe/Ljubljana",
  ro: "Europe/Bucharest",
  bg: "Europe/Sofia",
  gr: "Europe/Athens",
  tr: "Europe/Istanbul",
  is: "Atlantic/Reykjavik",
  ma: "Africa/Casablanca",
  eg: "Africa/Cairo",
  ke: "Africa/Nairobi",
  tz: "Africa/Dar_es_Salaam",
  ng: "Africa/Lagos",
  gh: "Africa/Accra",
  jp: "Asia/Tokyo",
  kr: "Asia/Seoul",
  th: "Asia/Bangkok",
  vn: "Asia/Ho_Chi_Minh",
  sg: "Asia/Singapore",
  my: "Asia/Kuala_Lumpur",
  ph: "Asia/Manila",
  ae: "Asia/Dubai",
  qa: "Asia/Qatar",
  sa: "Asia/Riyadh",
  om: "Asia/Muscat",
  jo: "Asia/Amman",
  il: "Asia/Jerusalem",
  lk: "Asia/Colombo",
  np: "Asia/Kathmandu",
  pe: "America/Lima",
  co: "America/Bogota",
  cr: "America/Costa_Rica",
  pa: "America/Panama",
  cu: "America/Havana",
  jm: "America/Jamaica",
  uy: "America/Montevideo",
};

/**
 * The destination's timezone, or null.
 *
 * `name` and `displayName` come from the geocoder. Both are checked, because the city
 * of interest is sometimes the leading segment of the display name rather than the
 * `name` field — "Barcelona, Catalonia, Spain".
 */
export function resolveDestinationTimezone(destination: {
  name?: string;
  displayName?: string;
  countryCode?: string;
}): TimezoneResolution | null {
  for (const candidate of cityCandidates(destination)) {
    const timezone = CITY_TIMEZONES[candidate];
    if (timezone) return { timezone, source: "city" };
  }

  const country = destination.countryCode?.trim().toLowerCase();
  if (!country) return null;

  /**
   * A multi-timezone country with no city match is left unknown.
   *
   * This is the point of the whole module: "Portugal" is not an answer, because Lisbon
   * and Funchal are an hour apart, and a plan that silently picked one would be wrong
   * for the other with no way for a reader to tell.
   */
  if (MULTI_TIMEZONE_COUNTRIES.has(country)) return null;

  const timezone = COUNTRY_TIMEZONES[country];
  return timezone ? { timezone, source: "country" } : null;
}

function cityCandidates(destination: {
  name?: string;
  displayName?: string;
}): string[] {
  const candidates: string[] = [];

  const add = (value: string | undefined) => {
    const key = value?.trim().toLowerCase();
    if (key && key.length > 1 && !candidates.includes(key)) candidates.push(key);
  };

  add(destination.name);
  for (const segment of (destination.displayName ?? "").split(",")) {
    add(segment);
  }

  return candidates;
}

/** True when the platform recognises the zone. Cheap, and it catches a typo in the table. */
export function isSupportedTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Wall-clock resolution                                                       */
/* -------------------------------------------------------------------------- */

export type WallClockResolution =
  | { status: "exact"; instant: Date; offsetMinutes: number }
  /** Spring forward: this local time does not exist on this date in this zone. */
  | { status: "skipped" }
  /** Fall back: this local time happens twice. */
  | { status: "ambiguous"; instant: Date; offsetMinutes: number }
  | { status: "invalid_timezone" };

/**
 * A local wall-clock date and time in a zone → the instant it names.
 *
 * ## Why this exists at all
 *
 * Comparing a scheduled visit to opening hours is *almost* pure wall-clock arithmetic:
 * both are local times at the destination, so no conversion is needed to ask "is 10:00
 * inside 09:00–17:00?".
 *
 * The exception is DST, and it is the reason the timezone is required rather than nice
 * to have. On a spring-forward morning a local time like 01:30 **does not exist** — the
 * clock jumps from 00:59 to 02:00 — and scheduling a visit then is not a schedule, it is
 * a mistake. On a fall-back morning 01:30 happens twice, so "open at 01:30" has two
 * answers.
 *
 * ## The algorithm
 *
 * Guess an instant by treating the wall clock as UTC, read the zone's offset there,
 * correct by it, then **verify** by formatting the corrected instant back and comparing
 * wall clocks. A mismatch means the requested time was skipped. Ambiguity is detected by
 * finding two offsets that both render the requested wall clock.
 *
 * The verification step is what makes this correct rather than approximately correct:
 * naively subtracting the offset is wrong precisely at the transitions this is here to
 * catch.
 */
export function resolveWallClock(input: {
  date: string;
  time: string;
  timezone: string;
}): WallClockResolution {
  if (!isSupportedTimezone(input.timezone)) {
    return { status: "invalid_timezone" };
  }

  const naive = Date.parse(`${input.date}T${normaliseTime(input.time)}:00Z`);
  if (Number.isNaN(naive)) return { status: "invalid_timezone" };

  const wanted = `${input.date} ${normaliseTime(input.time)}`;

  const candidates: { instant: Date; offsetMinutes: number }[] = [];

  /**
   * Two probes, and that is enough.
   *
   * A transition moves the offset by at most a couple of hours, so the correct instant is
   * within one offset-step of either probe. Probing at the naive instant and 24 h earlier
   * covers both sides of any transition on the day in question.
   */
  for (const probe of [naive, naive - 24 * 60 * 60 * 1_000]) {
    const offset = offsetMinutesAt(new Date(probe), input.timezone);
    if (offset === null) continue;

    const instant = new Date(naive - offset * 60_000);
    const rendered = renderWallClock(instant, input.timezone);
    if (rendered !== wanted) continue;

    const actual = offsetMinutesAt(instant, input.timezone);
    if (actual === null) continue;
    if (candidates.some((entry) => entry.offsetMinutes === actual)) continue;

    candidates.push({ instant, offsetMinutes: actual });
  }

  if (candidates.length === 0) return { status: "skipped" };
  if (candidates.length > 1) {
    // The earlier instant is the first occurrence, which is the conventional reading.
    const earliest = candidates.reduce((a, b) => (a.instant < b.instant ? a : b));
    return { status: "ambiguous", ...earliest };
  }

  return { status: "exact", ...candidates[0] };
}

/** The zone's UTC offset in minutes at a given instant, from the platform's IANA data. */
export function offsetMinutesAt(instant: Date, timezone: string): number | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    });
    const part = formatter
      .formatToParts(instant)
      .find((entry) => entry.type === "timeZoneName");
    if (!part) return null;

    // "GMT+01:00", "GMT-04:30", or bare "GMT" at zero offset.
    const match = /GMT(?:([+-])(\d{2}):(\d{2}))?/.exec(part.value);
    if (!match) return null;
    if (match[1] === undefined) return 0;

    const sign = match[1] === "-" ? -1 : 1;
    return sign * (Number(match[2]) * 60 + Number(match[3]));
  } catch {
    return null;
  }
}

/** `YYYY-MM-DD HH:MM` as the zone sees the instant. */
function renderWallClock(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);

  const get = (type: string) =>
    parts.find((entry) => entry.type === type)?.value ?? "";

  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/** `24:00` is a legal closing time but not a legal instant; it names midnight. */
function normaliseTime(time: string): string {
  return time === "24:00" ? "00:00" : time;
}
