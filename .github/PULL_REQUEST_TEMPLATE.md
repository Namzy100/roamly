## What changed

<!-- One or two sentences. What does this do that the repo did not do before? -->

## Why

<!-- The problem, not the solution. If this is a bug fix, what was the failure? -->

## Verification

Every box must be ticked before review, not after.

- [ ] `npx tsc --noEmit`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run verify:browser` — if any UI or store behaviour changed
- [ ] `PRODUCTION_BASE_URL=http://localhost:3000 npm run test:smoke:production` — if any route, metadata or env handling changed

## Invariants

Tick only what applies, and say how you know.

- [ ] No place reaches an itinerary except from a `VerifiedPlacePool`, or from a recorded retained place the plan already uses
- [ ] No model output names a place, coordinate, address or opening time
- [ ] No currency is converted anywhere
- [ ] No secret, prompt or provider host can reach a client bundle
- [ ] Persistence stays atomic and revision-guarded; a failure writes nothing
- [ ] Opening hours are never reported as closed from absent data
- [ ] Every money figure carries its basis, confidence and disclaimer

## Anything you are unsure about

<!-- Say so here rather than leaving it to be found in review. -->
