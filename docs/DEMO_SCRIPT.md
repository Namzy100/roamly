# Roamly — two-minute walkthrough

A demo script for a portfolio review. Written to be followed out loud by someone who is not a mapping
specialist, and to be understood by an interviewer who is not either.

Total: **about two minutes.** Timings are a guide, not a script to read verbatim.

---

## Before you start

- Have the app open at the landing page, on a laptop with a reasonable window.
- Clear saved trips if you have been testing (**storage panel → Clear all saved trips**).
- Decide which planner you will use. **Demo Planner** always works and needs no key; **Gemini** is more
  interesting to talk about if you have configured a key.

---

## 0:00 — What it is (15 s)

> "Roamly turns a budget, some dates and a vague idea of what you like into a day-by-day itinerary.
> The interesting part isn't the itinerary — it's that every single place in it is a real place that
> actually exists, and the app can prove it."

---

## 0:15 — Fill the form (15 s)

Type a destination, dates, budget, party size, and pick a couple of vibes.

> "Eleven fields. Budget, dates, pace, dietary needs, the things you care about."

---

## 0:30 — Confirm the destination (10 s)

Press **Find my destination**. Two or more matches appear.

> "It won't guess which Lisbon you meant. There's a Lisbon in Portugal and one in Ohio, and picking
> for you would be the first place a travel app could quietly get something wrong."

Choose the right one.

---

## 0:40 — Generate, and explain the rule (25 s)

Choose the planner. While the progress steps run:

> "Here's the bit I'd want to be asked about. The model never gets to name a place.
>
> First it decides *what kinds* of place each day needs — a café near the centre, a museum, dinner
> somewhere walkable. Then the **server** searches OpenStreetMap for exactly those, and gets back a
> fixed set of real places with real coordinates and real OSM ids. That set is called the pool.
>
> Then the model builds the itinerary — and the only thing it's allowed to say about a place is its
> **id**. It can't write a name, it can't write a coordinate, it can't write an address. If it
> references anything that isn't in the pool, the whole generation is thrown away and nothing is
> saved.
>
> So 'the AI made up a restaurant that doesn't exist' isn't a bug we have to catch. It's a shape the
> system can't express."

---

## 1:05 — The itinerary and the map (15 s)

Click a card; its map pin highlights. Click a pin; the card scrolls into view. Switch days.

> "Cards and map are the same selection. And every price here is labelled an estimate, because we have
> no live pricing — inventing one would be the same class of lie as inventing the restaurant."

---

## 1:20 — Calculate real routes (15 s)

Press **Calculate all routes**.

> "Now it draws actual walking and driving geometry from OpenStreetMap road data. Not a straight line
> between pins — a real path.
>
> And if a route can't be found, it says so rather than showing a plausible number. Look —" *(point at
> any unavailable leg, or the coverage line)* "— it tells you how much of the trip it managed."

---

## 1:35 — Opening hours (10 s)

Point at a stop's hours badge.

> "It reads OpenStreetMap's opening hours and checks them against the time it scheduled you for. Three
> states, not two: open, closed, and **we don't know** — which is the common one, because most places
> have no hours recorded.
>
> It will never tell you somewhere is closed just because it couldn't find out."

If a conflict is showing, point at the repair controls.

> "When it can tell, it offers to fix it — move the stop, swap the place, or leave the slot open."

---

## 1:45 — Change something (10 s)

Move a stop to another day, or add a backup to the itinerary.

> "Editing is bounded on purpose. There's no free-text box, because a text box could ask for a place
> that was never found. Every action is a specific typed change — and every alternative it offers comes
> from that same verified pool."

Press **Undo**.

> "One level of undo, and the revision number goes *forward*. Going back is a new fact about the trip,
> not a retraction."

---

## 1:55 — Close (10 s)

> "It runs with no API key, no database and no billing account. Free geocoding, free place data, free
> routing, free map tiles — and a deterministic planner so it works with no AI configured at all.
>
> Trips are saved in your browser, which is why there's an export button.
>
> It's a portfolio prototype, not production infrastructure. The public services it leans on are
> demo-grade and each one swaps out with a single environment variable."

---

## If you have another minute

Any of these is a good follow-up:

- **Refresh the available places** — re-runs the search and shows you exactly what changed, including
  the case where a place your trip uses has disappeared. Two policies, neither of which picks a
  replacement for you.
- **The storage panel** — how much room the trips take, and the export that exists because a browser is
  a single point of failure.
- **Offline** — turn the network off. The saved trip still reads, deterministic edits still work, and
  every provider-backed button disables itself with a reason rather than spinning.
- **`docs/ARCHITECTURE.md`** — the no-invention boundary, the pool mechanism, and why there is no
  exchange rate anywhere in the codebase.

---

## Questions worth being ready for

**"How do you know the model didn't invent a place?"**
Because it only ever emits ids, and the finished plan is checked against the search result set by
`assertItineraryUsesPool` before anything is stored. Mechanical, not reviewed.

**"What happens when the AI fails?"**
Nothing is written. The pipeline never persists — the browser saves the result only after it validates,
under an optimistic-concurrency guard. A refusal, a timeout or a rejected place all leave the saved trip
untouched rather than rolled back.

**"Why no exchange rates?"**
A rate is a live financial fact with a timestamp and there is no feed for one. The cost profiles hold
dimensionless multipliers, and each currency has its own hand-written band table. Inventing today's rate
would be wrong in a way nobody could see.

**"Is it production-ready?"**
No, and it does not claim to be. It is a prototype on donated public infrastructure. What it *is* is
honest about every claim it makes — and that was the design goal.
