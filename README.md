# Sentinel — agentic evaluation MVP

Point five subagents at a live web app. They use it the way a customer would,
propose defects, and a deterministic verification layer decides which of those
claims are real before anything reaches the report.

The deliverable is a markdown file. There is no dashboard, no auth system and no
billing, on purpose.

```bash
npm install && npx playwright install chromium
npm run eval                 # full run: 5 agents, verification, scored report
```

The report lands in `runs/<run-id>/report.md` with its evidence beside it.

A full sample report is committed at [`docs/sample-report.md`](docs/sample-report.md).
It is unedited output from the run summarised here.

A representative run against the 8-defect build — 5 agents, ~13 min wall clock,
$9.71 of agent spend:

| | |
|---|---|
| Raw agent claims | 15 |
| Published defects | 7 (all `CONFIRMED`, 5 merged as duplicates of the same defect) |
| Suppressed before publication | 2 |
| **False-positive rate** | **0%** |
| Same agents without the verification layer | 14.3% |
| Seeded defects detected | 7/8 (87.5%) — missed the duplicate-on-double-submit bug |
| Experience notes | 27 (7 major, 7 moderate, 3 minor, 10 praise) across 15 journey ratings |

---

The six capabilities this needs in order to be a product are specified in
[`docs/mvp-feature-list.md`](docs/mvp-feature-list.md), with honest status on
each.

## What's here

| | |
|---|---|
| `ledgerly/` | The app under test — a multi-tenant invoicing SaaS with 8 seeded defects and 5 honeypots |
| `sentinel/` | The product — agents, probe language, verifier, evidence layer, scoring, report |

`ledgerly` stands in for a customer's app. Every defect in it is declared in
`ledgerly/bugs.js` and can be toggled individually, which is what makes the
self-measurement below possible.

---

## The wedge: getting in, and staying reproducible

Agent orchestration is not a wedge — everyone has it. The part that decides
whether this works on a real customer's app is authentication and test data,
and that lives in `sentinel/src/harness.js`.

- **Real 2FA, not a bypass.** The harness performs the full handshake —
  password, then a 6-digit code it reads out of the app's mailbox endpoint,
  polling because the mail write and the login response race in practice. It
  then converts the session into Playwright storage state, so agents start
  already signed in and never burn turns (or flake) on a login form.
- **OTP as a first-class probe step.** `startLogin` / `submitOtp` hold a live
  challenge across steps. This matters more than it sounds: an agent that
  hardcodes a `challengeId` produces a probe that is dead by replay time, and
  its finding gets silently thrown away. That exact false-negative showed up in
  an early run and is what these ops fix.
- **Deterministic seeding.** Every run, and every single reproduction attempt,
  starts from a freshly seeded fixture with stable ids. Without this, "it
  reproduced twice" means nothing.

To integrate a real customer app, you implement the same three contracts:
seed/reset, a way to obtain an OTP, and a session handle.

---

## Findings are hypotheses until replayed

Agents do not get to say "the total looked wrong". Every finding must carry a
**probe**: a replayable step sequence plus one machine-checkable assertion that
is true when the defect is present (`sentinel/src/probe.js` — 14 step ops, 10
assertion kinds).

Each claim then goes through `sentinel/src/verify.js`, which the agents cannot
influence:

1. **Reproduce twice** on the target build, each time from a fresh seed in a
   fresh browser context. Non-deterministic claims surface as 1-of-2.
2. **Negative control** — replay against a known-good build. If the assertion
   also fires there, the probe is measuring intended behaviour or harness noise,
   not a regression, and the finding is suppressed. This is what catches
   confidently-wrong agent reports. In production the control is the last-good
   release rather than a bug-free build.
3. **Attribution** — replay with one seeded defect enabled at a time to name the
   underlying defect.

| Verdict | Meaning |
|---|---|
| `CONFIRMED` | 2/2 replays, silent on control |
| `FLAKY` | 1/2 — published, but labelled intermittent |
| `NOT_REPRODUCED` | 0/2 — withheld |
| `CONTROL_ALSO_FIRES` | fires on the good build too — withheld |
| `UNVERIFIABLE` | probe could not execute — withheld |

Confidence is computed from replay outcomes, never taken from the agent, because
the agent is the thing being checked. The report shows the agent's self-reported
confidence next to it so the two can be compared.

---

## Measuring our own false-positive rate

The number every buyer eventually asks about, tracked from run one.

A published finding counts as a true positive **only** if the attribution oracle
can name the defect behind it. Anything published that cannot be attributed is
counted as a false positive even when it looks plausible — the conservative
direction. No model is involved in that judgement, so the headline number cannot
be talked up by swapping in a better model.

The report prints both `falsePositiveRatePct` (what the customer actually saw)
and `unsuppressedFalsePositiveRatePct` (what the same agents would have shipped
with no verification layer). The gap between them is the product.

Suppressed claims are listed in the report rather than hidden, so the
suppression itself is auditable.

**Honeypots.** The app deliberately contains five correct behaviours that bait
false reports — a confirmation dialog before deleting, an empty state, a masked
password field, 2-decimal rounding, a redirect to login. They are declared in
`ledgerly/bugs.js` and are never seeded defects, so an agent reporting one is
measurably wrong.

---

## Two reports, deliberately separated

A verified defect list is not a product review, so every run produces two
write-ups with different standards of proof and different readers — a defect
report for whoever will fix it, and a softer report on what the app was actually
like to use and what would make it better:

| | Defects | Experience notes |
|---|---|---|
| Standard | probe-backed, replayed, control-checked | judgement |
| Verified | yes | **no, and labelled as such** |
| Counts toward the false-positive rate | yes | no |
| Answers | "is this broken?" | "what is this like to use, and what would make it better?" |

Keeping them apart is what lets both be honest. The defect list stays strict
enough that "failed" means failed, and because experience notes can never
inflate the defect count or the FP rate, agents can be candid about friction
they cannot reduce to an assertion — a slow action with no spinner, a filter
silently lost after saving, an empty state that does not say why it is empty.

Each note names the journey it belongs to, rates the friction
(praise / minor / moderate / major) and must propose a specific change.
Agents also score each journey they walked 1–5, which the report renders as a
scorecard sorted worst-first — the fastest read of where the product actually
hurts.

## Evidence

Built before the agents, not retrofitted. For every finding a reviewer gets the
exact steps in English, a screenshot at the point of failure, the console output
during replay, a Playwright trace, a session video, and the observed value the
assertion read — all linked by relative path from the report.

The target is that someone can tell in about thirty seconds whether the app
broke or the agent was wrong.

---

## The five agents

Each is its own `query()` call with its own model, browser session and evidence
bundle. Built-in file and shell tools are **denied**: an agent that could read
`ledgerly/server.js` would "find" every defect by reading the source, and the
evaluation would measure nothing.

| Dimension | Model | Lens |
|---|---|---|
| `auth-access` | `claude-opus-5` | login, OTP, sessions, cross-tenant access |
| `core-flows` | `claude-opus-5` | invoice arithmetic, create/pay journeys |
| `data-integrity` | `claude-opus-5` | deletes, orphans, boundary values |
| `accessibility` | `claude-sonnet-5` | labelling, error announcement, keyboard |
| `perf-visual` | `claude-sonnet-5` | latency budgets, 375px layout |

Reasoning-heavy lenses get Opus; the two whose tools hand back numbers
(`inspect_element`, `elapsedMs`) do not need it. `--model=` forces every agent
onto one model, and the report breaks the false-positive rate down per model —
so model choice becomes a measurable decision rather than a guess.

Agents drive the app through ten browser tools exposed as an in-process MCP
server: `open_page`, `snapshot`, `click`, `fill`, `select_option`, `press_key`,
`go_back`, `set_viewport`, `inspect_element`, `read_console`, `api_request`,
`screenshot`, `seed_app`. Confirm dialogs are accepted automatically, as a real
user clicking OK would.

### Journeys they are held to

Sign in with OTP · browse, search, filter and paginate invoices · open an
invoice's detail dialog by click **and** by keyboard · mark an invoice paid ·
create an invoice through the customer dropdown · add and delete customers ·
sign out.

Agents are held to judging the experience, not only whether something threw. A
common action that is slow, unreachable or silently does nothing is a defect
even when nothing crashed; everything softer than that becomes an experience
note against the journey it belongs to.

---

## Options

```bash
node sentinel/run.js [flags]

  --bugs=all|none|BUG-001,BUG-004   defects active in the target build
  --only=auth-access,core-flows     run a subset of dimensions
  --model=claude-sonnet-5           override every agent's model
  --no-attribute                    skip the oracle (disables the FP metric)
  --headed                          watch the agents work
  --concurrency=5
```

Agents validate every probe with `check_probe` before reporting it, which runs
the probe exactly as the verifier will. This exists because an early run found a
real layout defect and then lost it to a probe that targeted a button which was
not on screen.

`npm test` runs the harness regression suite: every user journey, dialog
handling, and the verification pipeline driven with hand-written claims
(a real defect, a honeypot, and a bogus claim) to confirm both suppression
paths still fire.

---

## Known limits

- The control build is a bug-free build of the same app. On a real customer this
  becomes the previous release, which is a weaker oracle — a defect present in
  both releases would be suppressed as intended behaviour.
- Attribution is linear in the number of seeded defects; it exists to measure
  ourselves on a known app, not to run against customer code.
- Findings whose probes cannot be expressed in the DSL are withheld rather than
  published unverified. That trades recall for precision deliberately.
