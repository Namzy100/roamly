# Roamly — durable notes for future sessions

Read `docs/ARCHITECTURE.md` before changing anything. These are the decisions that are easy to
accidentally undo.

## The rule everything rests on

A model may only ever emit a `placeId` from the trip's `VerifiedPlacePool`. Names, coordinates,
addresses and hours are attached afterwards from the canonical provider record, and
`assertItineraryUsesPool` checks the finished plan against the search result set. If you find yourself
widening that check, stop — the one legitimate exception is `retainedPlaces`, and it is enforced by
`validateRetainedPlaces` rather than by relaxing the assertion.

## Things that look like bugs and are not

- **No currency conversion anywhere.** Each currency has its own hand-written band table. There is no
  rate feed, so there is no rate. Adding one would be a fabrication.
- **`opening_hours` refuses more than it parses.** A string outside the supported subset produces
  `unknown_unparsed`, not a best-effort reading. `Mo-Fr 09:00-17:00; PH off` must never be read as
  weekday hours.
- **Unknown opening hours are not generation warnings.** Most OSM places have no tag; warning per stop
  would make every generation "partial". They live in the derived schedule report.
- **`next dev` in the browser suite is deliberate** — it needs the dev-only `__roamlyTripStore` seam.
  The screenshot script uses `next start` instead, because a dev badge must not appear in a published
  image.
- **Object identity does not survive a structural edit.** `commitStructuralEdit` re-parses the plan, so
  preservation is asserted by deep equality there and by `===` in the refinement appliers.

## Import barrel traps

`@/lib/generate` and `@/lib/refinement` re-export `server-only` modules. Anything reached from the
browser must import by file path (`@/lib/generate/pace-policy`, `@/lib/generate/assemble-plan`), not
through those barrels. The build fails loudly if you get this wrong.

## Before saying "done"

`npx tsc --noEmit && npm run lint && npm run build && npm test && npm run verify:browser`, then
`PRODUCTION_BASE_URL=http://localhost:3000 npm run test:smoke:production` against `npm start`.
Kill any stale `next start` on port 3000 first, or the smoke test will report failures belonging to old
code.
