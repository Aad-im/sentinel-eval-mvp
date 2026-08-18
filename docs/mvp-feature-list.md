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

## 4. Two reports: the hard one and the soft one

**What.** Every run produces two write-ups with different standards of proof and
different readers.

The **defect report** is probe-verified and adversarial: what is broken, proven.
Its reader is an engineer who will fix it.

The **experience report** is what the app was actually like to use and what would
make it better — friction, confusion, missing feedback, dead ends, and praise —
plus a 1–5 score per journey. It is judgement, labelled as such, and counts
toward neither the defect list nor the false-positive rate. Its reader is a
product or design lead who will prioritise it.

Ideas for making the second report substantially better are in
[The experience report](#the-experience-report-ideas-worth-building) below.

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

**What is missing.** The soft report is currently a *section* of the defect
report rather than its own document, so it reaches the engineer and not the
person who would act on it. Notes are also not deduplicated across agents — one
journey drew eight notes in our run, several restating the same friction.

**Done when.** The two reports are separate artifacts that can be delivered to
different people, and notes are clustered per journey with near-duplicates
merged.

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

## The experience report: ideas worth building

The defect half of this product has a clear ceiling — find real bugs, prove them,
do not cry wolf. The soft half has a much higher one, because almost everything
that makes software unpleasant never throws an error, and nobody is currently
selling a machine-generated review of it that is worth reading.

These are ordered by how much they would improve that report, not by effort.

### 1. Evaluate the cold start — we structurally cannot see it today

The single largest blind spot, and it was created by our own wedge. Agents are
handed a pre-authenticated session against a fully seeded account, because that
is what made runs fast and non-flaky. The cost is that the first-run experience
is invisible to us: in the canonical run all 16 seeds were the populated
`default` fixture, the `empty-org` fixture was never once used, and only 2 of 36
page visits touched `/login`.

So we have nothing to say about the experience that decides whether a trial
converts — signing up, an empty account with no data, what the product tells you
to do first, the moment before the app is useful. Empty states are exactly where
software is worst and where feedback is most valuable.

**Build.** A cold-start agent that begins signed out, on an empty org, with no
seeded data, and is asked only to become a productive user. Report where it got
stuck. This is a different lens, not a sixth dimension of the same one.

### 2. Weight friction by how often the action happens

A rough edge in sign-in is met every session. A rough edge in deleting a customer
is met twice a year. Right now both arrive as "moderate" and the reader has to
supply the frequency themselves.

**Build.** Journey frequency in the target profile (per-session / daily / weekly /
rare), and rank notes by friction × frequency. It turns a flat list into a
priority order the customer did not have to compute.

### 3. Keep disagreement instead of averaging it away

Four agents scored "Inspect an invoice" 2, 4, 4 and 3. The report showed 3.3.
The spread was the interesting part and we deleted it: when independent reviewers
disagree that sharply, the experience is inconsistent or depends on context, and
that is worth more than the mean.

**Build.** Show the distribution, not just the average. Flag any journey where
the spread exceeds a threshold as "inconsistent experience" and quote the
dissenting agent's reason verbatim.

### 4. Give the soft report evidence too

Defects get screenshots, video and traces. Experience notes get prose, even
though "the modal is cramped on a phone" and "saving is silent" are far more
persuasive as a picture and a five-second clip. The capture already exists; the
notes simply are not wired to it.

**Build.** Let an agent attach the screenshot or video segment it was looking at
when it wrote a note. Near-free, and it makes the soft report the one people
actually forward.

### 5. Rank by effort, and lead with the cheap wins

Twenty-seven suggestions is a wall, and a wall gets skimmed. Some of ours were a
one-line copy change ("say *No paid invoices* when a filter emptied the list");
others were real design work.

**Build.** An effort estimate per suggestion, and a short "three things worth
doing this week" block at the top — high frequency, high friction, low effort.
That block is what makes the report get acted on rather than filed.

### 6. Judge against the customer's intent, not generic taste

Agents currently review with no idea what the product is trying to be or who it
is for. Some friction is deliberate: a confirmation step, a deliberately slow
destructive action, a power-user shortcut that is meant to be discoverable only
by power users. We call those confusing because we have no way to know better.

**Build.** Let the customer state the target user, the product's intent for each
journey, and any deliberate friction, in the target profile. This is the soft
report's version of the negative control: a way to separate "bad" from
"not what I would have done".

### 7. Trend the scores, do not just print them

A single score is an opinion. The same score across releases is a metric. "Bill
someone dropped from 4.1 to 2.4 after last week's release" is a sentence a
product lead will act on immediately, and it is the strongest argument for
running us continuously rather than once.

**Build.** Persist journey scores per run and chart them over time. Depends on
run-over-run identity (feature 6), which is the main reason that feature earns
its slot.

### 8. Open with a narrative, not a list

The current report opens with a scorecard table. An exec reads five sentences.

**Build.** A short synthesis at the top, written after everything else, that says
what this product is like to use in plain prose — the strongest thing about it,
the worst thing about it, and the one change that would most improve it.

---

## Priority

1, 2, 3 exist and hold up; the work is generalising 1 off our demo app. 5 is the
biggest genuine hole — without adjudication we cannot quote a false-positive rate
on a real pilot, and that is the number the pilot turns on. 6 is small but
decides whether run two is worth paying for.

Within the soft report, the cold-start lens is the one to build first. It is the
only item on that list that adds something we currently cannot see at all, rather
than presenting better what we already collect.

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

A dashboard, an auth system, and billing. The deliverable is two markdown files
we email — the defect report and the experience report. Also out: CI integration, self-healing test suites, and evaluating
anything other than a running web app through a browser.

One rule worth keeping: agents get browser tools only. File and shell access is
denied, because an agent that can read the app's source will "find" every defect
by reading it, and the evaluation would measure nothing.
