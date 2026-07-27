import { NotebookPen } from "lucide-react";

import type { DestinationSummary } from "@/lib/schemas";

export function PracticalNotes({
  notes,
  destination,
}: {
  notes: string[];
  destination: DestinationSummary;
}) {
  const facts = [
    { label: "Language", value: destination.languageNote },
    { label: "Money", value: destination.currencyNote },
    { label: "Weather", value: destination.weatherNote },
  ];

  return (
    <section
      aria-labelledby="notes-heading"
      className="flex flex-col gap-4 rounded-2xl border border-line bg-cream-raised p-5"
    >
      <h3
        id="notes-heading"
        className="flex items-center gap-2 font-display text-lg text-forest"
      >
        <NotebookPen aria-hidden className="size-4 text-terracotta" />
        Before you go
      </h3>

      <dl className="flex flex-col gap-3">
        {facts.map((fact) => (
          <div key={fact.label} className="flex flex-col gap-1">
            <dt className="eyebrow text-ink-muted">{fact.label}</dt>
            <dd className="text-sm leading-relaxed text-ink text-pretty">
              {fact.value}
            </dd>
          </div>
        ))}
      </dl>

      <ul className="flex flex-col gap-2.5 border-t border-line pt-4">
        {notes.map((note) => (
          <li
            key={note}
            className="flex items-start gap-2 text-sm leading-relaxed text-ink-muted text-pretty"
          >
            <span
              aria-hidden
              className="mt-1.5 size-1.5 shrink-0 rounded-full bg-terracotta"
            />
            {note}
          </li>
        ))}
      </ul>
    </section>
  );
}
