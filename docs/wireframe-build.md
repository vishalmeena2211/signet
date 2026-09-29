# Building the console from the wireframes

The target is the frames in the reimagined wireframes (v2, 28 Sep 2026; frames 30–33 and the rework of 26 added 29 Sep 2026):
https://claude.ai/artifact/GSNFFXySzjVfjzFRGc2i9f — a 100% match, nothing extra, nothing less.

**How to read this file**
- **Frame** — one drawn screen in the wireframes, numbered as in the wireframe index (01–29).
- **Built** — the screen exists in the new console and does what the frame's notes say.
- **Checked** — a screenshot of the running console was compared side by side with the frame and they match. A frame is not done until it is checked.
- **Backend** — server work the frame needs that did not exist before this build.
- **Example data** — the wireframes show a made-up repo (cartographer) and feature. The build shows real data, so names and numbers differ; layout, wording, colour and behaviour must not.

## Decisions taken where the wireframes left a question open

- Desk order: oldest first. The morning page still suggests the seal that finishes a feature.
- Routines: one clause per routine, as drawn.
- "Seal on trust" is for a person only; a routine never seals, on trust or otherwise.
- Phone (frame 29): built as the page at phone width. Signet stays reachable from this machine only until the owner chooses how a phone should reach it (a tunnel they control, or a relay) — that is a security decision, not a layout one.

## Removed, because no frame shows them

- Runs list, Graph, Activity feed, the old Overview/Work/Feature screens, the eight-tab sidebar. Their code stays in git history.
- The node-and-wire automation canvas was removed on 28 Sep, then asked for back on 29 Sep. It returns as frames 30–33, drawn first and built from those.

## Frames

Checked on 28 Sep 2026 against the running console, frame by frame. Where a frame is only partly matched, the gap is written under it.

### First run
- [x] Built  - [x] Checked — 01 What should I work on?
- [x] Built  - [x] Checked — 02 Here is your repo, as I read it

### Desk
- [x] Built  - [ ] Checked — 03 Good morning
  - Gap: the sentence ends "It spent $2.40" without "— 31% of this week's quota". Signet records what each run cost, but not the size of the weekly quota, so a percentage would be invented. Everything else on the frame matches.
- [x] Built  - [x] Checked — 04 Three decisions waiting — J / K / Enter / E work
- [x] Built  - [x] Checked — 05 Nothing needs you
- [x] Built  - [x] Checked — 06 Held · your Claude quota ran out — checked with a quota window made in the database, then removed

### Ask
- [x] Built  - [x] Checked — 07 You describe it; Signet reads the repo
- [x] Built  - [x] Checked — 08 Signet asks before it proposes
- [x] Built  - [x] Checked — 09 The proposal, ready to initial
- [x] Built  - [x] Checked — 10 Reshape the plan by hand — cut and file moves checked live; dragging checked by firing the drag events in the page, because the browser tool cannot hold a drag
- [x] Built  - [x] Checked — 11 A fence that encloses nothing — checked by stubbing the proposal in the page, because a real proposal with an empty fence could not be made on demand

### Initial and seal
- [x] Built  - [x] Checked — 12 Initial the plan
- [x] Built  - [x] Checked — 13 Seal the work — on a real step, both promises proven
- [x] Built  - [x] Checked — 14 Sealed — including "Take it back", which was used for real (the revert landed as 7e3fffc)
- [x] Built  - [ ] Checked — 15 A promise with no proof
  - Gap: the frame marks one proof line "added by the repair". Signet does not yet record which lines came from a repair round, so that label is not shown. The rest (6 of 7 proven, seal on trust, the commit trailer) was checked on a real step.
- [x] Built  - [x] Checked — 16 Send it back with a note
- [x] Built  - [x] Checked — 17 Your checkout is elsewhere

### Thread
- [x] Built  - [x] Checked — 18 A feature, as one timeline
- [x] Built  - [x] Checked — 19 Watch it work
- [x] Built  - [x] Checked — 20 It reached outside the fence — a real fence question from a real run, answered "widen"
- [x] Built  - [ ] Checked — 21 Signet stopped to ask you
  - Gap: the layout was checked, but no real run has yet stopped to ask with choices, so the choices have not been seen coming from the agent. The backend reads them and has tests.
- [x] Built  - [ ] Checked — 22 A check caught it, and it fixed itself
  - Gap: not yet seen on a run that needed a repair; every real run in this build passed its checks first time.

### Flow
- [x] Built  - [x] Checked — 23 Everything in motion · the canal
- [x] Built  - [x] Checked — 24 The ledger

### Workshop
- [x] Built  - [x] Checked — 25 Conventions, decided in batches — checked with conventions from another repo, since the current one has none yet
- [x] Built  - [x] Checked — 26 Routines, written as sentences
  - Reworked 29 Sep: a Sentence / Canvas switch. - [x] Built  - [x] Checked
- [x] Built  - [x] Checked — 27 Health

### Anywhere
- [x] Built  - [x] Checked — 28 The command bar
- [ ] Built  - [ ] Checked — 29 Seal from your phone
  - Built: the right-hand phone (the seal at phone width), checked at 375 px.
  - Not built: the left-hand phone, the lock-screen notification. It needs Signet to reach a phone, which is the open decision above.

### Workshop · routines as a canvas (added 29 Sep 2026)
- [x] Built  - [x] Checked — 30 Routines, drawn as a canvas — Backend: none new
  - Checked live: a routine built from a blank board by dropping a trigger and two recipes, reordered by dragging a card with the mouse, a card and the trigger opened on the right. Dropping from the palette was checked by firing the drag events in the page, because the browser tool cannot do a native drag and drop.
  - Added, because the frame implies them but does not draw them: choosing which routine to draw, a blank board for a new one, and a small form behind “New recipe”.
  - React Flow’s attribution link stays in the corner of the board.
- [ ] Built  - [ ] Checked — 31 Branch on what it found — Backend: new; a database change
  - Not built: approved by the owner on 29 Sep, but the migration was refused by the session’s permission policy. Needs the permission granted, or the migration run by hand.
- [x] Built  - [x] Checked — 32 A routine that could start itself — Backend: none new; the chain limit exists
  - Checked live: choosing “A run fails” drew the loop and the warning; a limit of 0 was kept and saved. A quota coming back also counts as something the routine’s own work can cause.
- [x] Built  - [x] Checked — 33 Last night's firing, on the canvas — Backend: one new read of a routine's recent firings
  - Checked live on two real past firings: one sealed (grey), one still waiting on a question (seal colour, with Look).

## Tally

- Built and checked: 24 of the first 29, plus 30, 32, 33 and the rework of 26.
- Not built: 31 (branches), waiting on permission for its database change.
- Also built, to make a frame note true: a routine that stops is now on the Desk, with Dismiss and Look.
- Built, with a gap or not yet seen live: 03, 15, 21, 22.
- Half built: 29.
