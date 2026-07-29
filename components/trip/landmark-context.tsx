"use client";

import { BookOpen } from "lucide-react";
import { useId, useState } from "react";

import type { LandmarkContextView } from "@/lib/trip/landmark-context";
import { cn } from "@/lib/utils";

/**
 * The landmark region of one itinerary card (Checkpoint 5B, section 10C).
 *
 * ## A plain `<img>`, and why that is the correct choice rather than a concession
 *
 * `next/image` would require a `remotePatterns` entry for `upload.wikimedia.org`, and this checkpoint forbids
 * broadening remote-image configuration — for a good reason. A remote pattern is a standing permission granted to a
 * host for the whole application, and the URL here has already passed a much narrower gate: `mediaIsDisplayable`
 * accepted exactly one file, from one allowlisted host, with a licence that permits display.
 *
 * So the element is a plain `<img>` pointing at the exact URL the sidecar stored. No proxy, no loader, no preload,
 * nothing written to disk. The file is fetched by the browser, from Commons, when it scrolls into view.
 *
 * ## The failure state hides the image and nothing else
 *
 * A dead URL — a deleted file, a blocked network — must cost the traveller the photograph and not the paragraph. The
 * `onError` handler sets one boolean in this component: no request, no store write, no map update, nothing that
 * could turn a missing image into a changed trip.
 *
 * ## Cropping is a licence question, not a layout one
 *
 * `transformationPermitted` decides `object-cover` versus `object-contain`. A file whose licence forbids
 * modification may be letterboxed but not cropped, and a card that always cropped would be quietly editing
 * somebody's photograph to fit a box.
 *
 * ## The disclosure is `<details>`
 *
 * Native, so it is keyboard-reachable, works with no JavaScript, and cannot become hover-only. A hover tooltip
 * carrying licence terms is unreachable on touch, which for an attribution is not a polish problem.
 */
export function LandmarkContext({
  view,
  itemId,
}: {
  view: LandmarkContextView;
  /** For the test hooks, so a browser check can target one card's region among many. */
  itemId: string;
}) {
  const labelId = useId();

  /**
   * Whether the photograph failed to load.
   *
   * The only state here. It is never reset: a URL that failed once in this session is not worth a second attempt,
   * and re-mounting the card — a day change, a reorder — gives it one anyway.
   */
  const [imageFailed, setImageFailed] = useState(false);

  const photo = view.photo;
  const showImage = photo !== null && !imageFailed;

  return (
    <section
      aria-labelledby={labelId}
      data-testid="landmark-context"
      data-item-id={itemId}
      data-has-image={showImage ? "true" : "false"}
      className="flex flex-col gap-2.5"
    >
      <h5
        id={labelId}
        className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-forest uppercase"
      >
        <BookOpen aria-hidden className="size-3.5 text-terracotta" />
        {view.label}
      </h5>

      {/*
       * One image, in a box whose height is decided before it loads.
       *
       * The wrapper holds the ratio so nothing below it moves when the file arrives, and it is rendered only when
       * there is a file — an empty frame reads as an image that failed rather than as a place without a photograph.
       */}
      {showImage ? (
        <div className="aspect-[16/9] w-full overflow-hidden rounded-xl bg-sand/60">
          {/*
           * `next/image` would need a `remotePatterns` entry for `upload.wikimedia.org`, which this checkpoint
           * forbids — see the note at the top of this file.
           */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photo.url}
            /* Non-empty by `mediaIsDisplayable`, and bounded at 512 characters by the media schema. */
            alt={photo.altText}
            /*
             * The declared box, not the file's intrinsic size — which the sidecar does not store. Present so the
             * browser reserves the right shape on first layout; the wrapper's ratio is what actually governs.
             */
            width={640}
            height={360}
            loading="lazy"
            decoding="async"
            /* Commons needs no referrer, and a trip URL is not something to hand to a third party. */
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
            data-testid="landmark-photo"
            className={cn(
              "size-full",
              /* A licence that forbids modification permits letterboxing, not cropping. */
              photo.transformationPermitted ? "object-cover" : "object-contain",
            )}
          />
        </div>
      ) : null}

      {view.description ? (
        <p
          data-testid="landmark-description"
          className="text-sm leading-relaxed text-ink text-pretty"
        >
          {view.description.text}
          {view.description.staleNote ? (
            <>
              {" "}
              <span
                data-testid="landmark-stale-label"
                className="inline-flex items-center rounded-full bg-sand px-2 py-0.5 align-middle text-[0.6875rem] font-medium text-ink-muted"
              >
                {view.description.staleNote}
              </span>
            </>
          ) : null}
        </p>
      ) : null}

      {/* A definition list, because every row is a labelled value. Absent entirely when there are none. */}
      {view.facts.length > 0 ? (
        <dl
          data-testid="landmark-facts"
          className="flex flex-wrap gap-x-4 gap-y-1 text-xs"
        >
          {view.facts.map((fact) => (
            <div key={fact.label} className="flex gap-1.5">
              <dt className="text-ink-muted">{fact.label}</dt>
              <dd className="font-medium text-ink">{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {/*
       * The source line, and the credits behind it.
       *
       * `<details>` rather than a button with state: the summary is the visible attribution and is always readable,
       * and opening it costs no JavaScript. The licence identifier in the summary is the exact stored value.
       */}
      <details
        data-testid="landmark-source"
        className="group/source text-[0.6875rem] text-ink-muted"
      >
        <summary
          data-testid="landmark-source-line"
          className="cursor-pointer list-none rounded underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {view.sourceLine}
          <span className="ml-1 opacity-70 group-open/source:hidden">
            {" "}
            — details
          </span>
        </summary>

        <dl
          data-testid="landmark-attribution"
          className="mt-1.5 flex flex-col gap-0.5 rounded-lg bg-sand/50 px-2.5 py-2"
        >
          {view.disclosure.map((row) => (
            <div key={row.label} className="flex flex-wrap gap-1.5">
              <dt className="text-ink-muted">{row.label}</dt>
              <dd className="min-w-0 text-ink">
                {row.href ? (
                  /*
                   * `noreferrer` as well as `noopener`: the second stops the new tab reaching back through
                   * `window.opener`, the first stops Commons being told which trip page the reader came from.
                   */
                  <a
                    href={row.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="landmark-source-link"
                    className="break-words underline underline-offset-2 hover:text-forest"
                  >
                    {row.value}
                  </a>
                ) : (
                  /* Plain text. Every value here is a text node — nothing is ever set as markup. */
                  <span className="break-words">{row.value}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}
