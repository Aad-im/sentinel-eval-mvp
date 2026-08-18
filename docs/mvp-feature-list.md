# MVP feature list

The six capabilities this product cannot ship without, in dependency order.

Each one is here because building the prototype proved it was load-bearing —
usually by breaking. Status is honest: most of the machinery exists and works
against our own demo app, and the recurring gap is that it is wired to *that*
app rather than to an arbitrary customer's.

**The thing we are selling.** A software company points us at part of their app.
Agents use it like a customer would. They get back a short list of defects that
are actually real, each one provable in thirty seconds, plus an honest review of
what using that part of the product feels like.

Everything below serves that sentence. Anything that does not is out of scope —
see the bottom of this document.

---

## 1. Target profile: seed, auth, and scope

**What.** One config artifact per customer app that answers: where does it live,
how do we get in, how do we reset it to a known state, and which journeys matter.

**Why it is non-negotiable.** This is the whole demo-app-to-real-app gap, and it
is where these companies die. An agent cannot evaluate an app it cannot log into,
and no finding is worth anything if it cannot be replayed from a known state —
"it reproduced twice" is meaningless if the two runs started from different data.
Our OTP handling is not a shortcut around 2FA; it completes the real handshake
and caches the session, which is what keeps agents from burning turns and
flaking on a login form.

**What exists.** `sentinel/src/harness.js` implements all three contracts —
deterministic reseeding, full password + emailed-OTP login with polling, and
session reuse as Playwright storage state. It works, and the auth wedge has never
been the failure mode in any run.

**What is missing.** It spawns `ledgerly/server.js` by path. Journeys A–G are
prose inside an agent charter. There is no way to say "test only checkout."
This must become a declarative profile — base URL, auth strategy, seed hook,
journeys, out-of-bounds paths — with auth strategies for the three real cases:
emailed OTP, TOTP seed, and a customer-provided session token.

**Done when.** A new app is onboarded by writing a profile and nothing else, and
the profile can scope a run to a named subset of journeys.

---

## 2. Verified findings: probe, replay, negative control

**What.** No claim is published on an agent's say-so. Every finding carries a
replayable probe whose assertion is true when the defect is present. The verifier
replays it twice from a fresh seed, then once against a known-good baseline.

**Why it is non-negotiable.** This is the product. Agent orchestration is not a
wedge — everyone has it. What a buyer is actually paying for is that when we say
"failed", it failed. The negative control is the part that earns that: a claim
that also fires on the baseline is describing intended behaviour or harness
noise, not a regression. In our run it silently killed two confident, plausible,
wrong claims that every other part of the system was happy to publish.

**What exists.** `probe.js` (14 step ops, 10 assertion kinds), `verify.js`
(double replay, control comparison, five verdicts), and `check_probe`, which
lets an agent test a probe before submitting it. That last one exists because a
run found a real layout defect and then *lost* it to a probe pointing at a button
that was not on screen — a broken probe discards a true finding exactly like a
false one.

**What is missing.** The baseline is a bug-free build of the same app. On a real
customer it becomes the previous release, which is strictly weaker: a defect
present in both releases gets suppressed as intended behaviour. Needs an explicit
baseline strategy per customer, and the report must say which was used.

**Done when.** The baseline is configurable (previous release, staging, or a
recorded snapshot), and every published finding names the baseline it survived.

---

## 3. Evidence bundle per finding

**What.** For each finding: steps in plain English, a screenshot at the failure,
console output during replay, the observed value the assertion read, a Playwright
trace, and a session video — all linked from the report.

**Why it is non-negotiable.** When our agent says "failed", the customer must be
able to tell in about thirty seconds whether the app broke or our agent was
wrong. That judgement is where trust is won or lost, and retrofitting the
capture is painful, so it was built before the agents rather than after.

**What exists.** `evidence.js` captures all of it — a single run produced 111
screenshots, 10 videos and 15 traces. Confidence is computed from replay
outcomes and shown next to the agent's self-reported confidence, so a reader can
see where the model was overconfident.

**What is missing.** ~72MB per run with no retention policy or hosting. The
report links relative paths that only resolve on the machine that ran it.

**Done when.** Evidence is uploaded to durable storage, links resolve for a
recipient who never had the repo, and there is a retention window.

---

## 4. Two output channels: verified defects and experience review

**What.** Agents report on two channels with different standards of proof.
Defects are probe-verified. Experience notes — friction, confusion, missing
feedback, praise — are judgement, labelled as such, and count toward neither the
defect list nor the false-positive rate. Plus a 1–5 score per journey.

**Why it is non-negotiable.** A verified defect list is not a product review, and
most of what makes software bad to use never throws an error. The separation is
what lets both halves be honest: the defect list stays strict enough that
"failed" means failed, and precisely because notes cannot inflate any metric,
agents can be candid about things they cannot reduce to an assertion. Our run
produced 27 notes, and two claims correctly suppressed as *defects* — no save
confirmation, Escape does not close a dialog — resurfaced as useful *experience*
findings instead of being lost.

**What exists.** Both channels, the journey scorecard sorted worst-first, and a
`checkedButHealthy` list per agent so silence is not ambiguous.

**What is missing.** Nothing structural. Experience notes are not deduplicated
across agents, so the same friction can appear several times.

**Done when.** Notes are grouped by journey and near-duplicates merged.

---

## 5. Honest false-positive measurement

**What.** Track, from run one, what fraction of what we published was wrong.
Report it next to what the same agents would have shipped without verification.

**Why it is non-negotiable.** It is the number every buyer eventually asks about
and the number that kills pilots. It has to be measured in a way we cannot
flatter ourselves with — which is why no model is in that loop. Attribution
replays each finding with one defect enabled at a time; a published finding no
defect explains counts against us even when it looks plausible.

**What exists.** `scoring.js`, the attribution oracle, and per-model breakdown
(0% published FP vs 14.3% unverified in the canonical run). The per-model split
turns model choice into a measurable decision rather than a guess.

**What is missing — the biggest hole in the product.** Attribution needs
toggleable known defects. A customer app has none, so on a real pilot we cannot
compute this number at all. It needs replacing with a human adjudication loop:
each published finding gets a customer verdict (real / not real / won't fix), and
the FP rate is computed from those verdicts. That also produces the labelled data
for improving suppression.

**Done when.** Every published finding can be adjudicated by a human in one
click, and the rate is computed from real verdicts across pilots — not only from
our synthetic oracle.

---

## 6. Run-over-run continuity and delivery

**What.** A finding has a stable identity across runs. Each report says what is
new, what persists, what was fixed, and what regressed. The report reaches a
human without anyone SSHing into a box.

**Why it is non-negotiable.** The second run is where the product either becomes
valuable or becomes noise. Re-reporting the same seven defects with no memory
trains the customer to ignore us, and "fixed" is the only output that proves we
caused anything. Delivery is table stakes: a markdown file on disk is not
delivered.

**What exists.** `signature()` collapses duplicate claims within a single run,
and post-attribution merge collapses the same defect found via different
endpoints. That is the right primitive, one run wide.

**What is missing.** No persistence between runs, no fingerprint stable across
code changes, no new/persisting/fixed/regressed diff, and no delivery of any
kind — no email, no webhook, no upload.

**Done when.** Two consecutive runs produce a diff rather than two full lists,
and a run ends by emailing the report to a configured address.

---

## Priority

1, 2, 3 exist and hold up; the work is generalising 1 off our demo app. 5 is the
biggest genuine hole — without adjudication we cannot quote a false-positive rate
on a real pilot, and that is the number the pilot turns on. 6 is small but
decides whether run two is worth paying for.

| # | Feature | State | Next move |
|---|---|---|---|
| 1 | Target profile: seed, auth, scope | works, wired to our app | declarative profile + auth strategies |
| 2 | Verified findings | works | configurable baseline |
| 3 | Evidence bundle | works | durable hosting + retention |
| 4 | Defects + experience review | works | dedupe notes |
| 5 | Honest FP measurement | works only with our oracle | human adjudication loop |
| 6 | Continuity + delivery | within-run only | cross-run identity + email |

---

## Explicitly out of scope for the MVP

A dashboard, an auth system, and billing. The deliverable is a markdown file we
email. Also out: CI integration, self-healing test suites, and evaluating
anything other than a running web app through a browser.

One rule worth keeping: agents get browser tools only. File and shell access is
denied, because an agent that can read the app's source will "find" every defect
by reading it, and the evaluation would measure nothing.
