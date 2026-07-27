import { MapPinned, Route, ShieldCheck } from "lucide-react";

const PROOF_POINTS = [
  {
    icon: ShieldCheck,
    title: "Real places only",
    body: "Restaurants, hotels and sights come from a verified places index — never invented by a model.",
  },
  {
    icon: Route,
    title: "Costed and timed",
    body: "Every stop carries an estimate, and every gap between them is real travel time.",
  },
  {
    icon: MapPinned,
    title: "Itinerary and map together",
    body: "Tap a stop to find it on the map. Tap a pin to find it in the plan.",
  },
];

export function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-line">
      {/* Warm ambient wash — restrained, no gradient banding on wide screens. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60rem_40rem_at_15%_-10%,var(--sand),transparent_65%),radial-gradient(50rem_35rem_at_95%_0%,var(--terracotta-soft),transparent_60%)] opacity-70"
      />

      <div className="relative mx-auto w-full max-w-6xl px-5 pt-16 pb-14 sm:px-8 sm:pt-24 sm:pb-20">
        <div className="flex max-w-3xl flex-col gap-6">
          <span className="eyebrow inline-flex w-fit items-center gap-2 rounded-full border border-line bg-cream-raised/80 px-3 py-1.5 text-forest">
            <span className="size-1.5 rounded-full bg-terracotta" />
            Itinerary studio
          </span>

          <h1 className="font-display text-4xl leading-[1.05] tracking-tight text-forest text-balance sm:text-6xl lg:text-7xl">
            Trips worth taking,
            <br />
            planned properly.
          </h1>

          <p className="max-w-xl text-lg leading-relaxed text-ink-muted text-pretty sm:text-xl">
            Tell Roamly your budget, your pace and what you actually care about.
            Get a day-by-day plan with real restaurants, honest travel times and
            a cost against every stop.
          </p>
        </div>

        <dl className="mt-14 grid gap-6 sm:mt-16 sm:grid-cols-3 sm:gap-8">
          {PROOF_POINTS.map(({ icon: Icon, title, body }) => (
            <div key={title} className="flex flex-col gap-2.5">
              <div className="flex size-9 items-center justify-center rounded-xl border border-line bg-cream-raised text-forest">
                <Icon aria-hidden className="size-4" />
              </div>
              <dt className="text-sm font-semibold text-ink">{title}</dt>
              <dd className="text-sm leading-relaxed text-ink-muted text-pretty">
                {body}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
