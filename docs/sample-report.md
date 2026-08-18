# Ledgerly — automated evaluation report

> **Sample output.** This is a real, unedited report from one run of
> `npm run eval` against the 8-defect build of `ledgerly/`. The evidence links
> below (screenshots, videos, Playwright traces) point into that run's
> `runs/<run-id>/` directory, which is not committed — it is ~72MB per run.
> Run the evaluator yourself to regenerate both the report and its evidence.

---


**Run** `run-2026-08-18T03-20-27` · started 2026-08-18T03:20:27.090Z · wall clock 687s · agent spend $9.71

Target build `all`. Findings were replayed against control build `none` before publication.

## Summary

| | |
|---|---|
| Defects published | **7** (7 confirmed, 0 intermittent) |
| Claims suppressed before publication | 2 |
| **False-positive rate (published)** | **0%** |
| False-positive rate without the verification layer | 14.3% |
| Seeded defects detected | 7/8 (87.5%) |
| Experience notes (unverified judgement) | 27, of which 14 moderate or worse |

## Findings

### 1. Cross-tenant IDOR: GET /api/invoices/:id returns another org's invoice in full

**✅ CONFIRMED** · severity **critical** · confidence **95%** · dimension `auth-access`

Signed in as the primary tenant (Ada / Vertex Consulting, org_00001), a direct GET of a foreign invoice id (inv_00281 / RI-1000, owned by Rival Industries, org_00002) returns HTTP 200 with the complete invoice — number, description, customer name and email, quantities, unit price, and totals. The invoice does not appear in the primary tenant's list or search (those are correctly tenant-scoped), so the detail read path is missing the tenant ownership check that every other route enforces.

| | |
|---|---|
| **Expected** | A request for an invoice belonging to a different org should be refused with 404 (as the pay, delete, and customer-detail routes correctly do), leaking nothing about the other tenant's data. |
| **Actual** | GET /api/invoices/inv_00281 as primary returns 200 with the full foreign invoice body, including the foreign customer's billing email (billing0@northwindtraders.test) and financial figures. The pay route (POST .../pay → 404), delete route (DELETE → 404), and customer-detail route (GET /api/customers/cus_00017 → 404) all correctly block the same cross-tenant access, isolating this as a read-path authorization gap. |
| **Impact** | Any authenticated customer can walk invoice ids and read every other tenant's invoices — descriptions, customer contacts, amounts. For a multi-tenant invoicing SaaS this is a confidentiality breach of competitors' billing data and the single most serious defect class here. |
| **Reproduced** | 2/2 independent replays, each from a fresh seed |
| **Control build** | assertion did **not** fire — behaviour is specific to this build |
| **Observed value** | `RI-1000` |
| **Root defect** | `BUG-002` — IDOR: GET /api/invoices/:id is not scoped to the caller org (GET /api/invoices/:id) |

**Steps to reproduce**

1. Reset the app to the `default` fixture
2. Sign in as **primary** (password + emailed OTP)
3. `GET /api/invoices/inv_00281` as **primary**

**Automated check** — this finding is recorded as present when `number` in the response body is `RI-1000`.


**Evidence** — [screenshot at failure](evidence/verify/01-auth-access/screenshots/001-assert.png) · [step trace](evidence/verify/01-auth-access/steps.jsonl) · [Playwright trace](evidence/verify/01-auth-access/trace.zip) · [agent session video](evidence/agents/auth-access/video/page@68974b84708a4e41f621d01099381b69.webm) · [agent screenshot](evidence/agents/auth-access/screenshots/002-open_app.png)

<sub>Agent self-reported confidence was 96%; the confidence above is computed from replay outcomes, not from the agent.</sub>


### 2. Tax is calculated on the unit price instead of the line subtotal, under-billing every invoice with quantity > 1

**✅ CONFIRMED** · severity **critical** · confidence **95%** · dimension `core-flows` · independently reported by 2 agents

The invoice total is computed as (qty × unitPrice) + (unitPrice × taxRate) — the quantity multiplier is omitted from the tax term. For an invoice of 4 × $100.00 at the stated 20% rate, Ledgerly stores subtotal $400.00, tax $20.00, total $420.00. The correct tax is $80.00 and the correct total $480.00, so the customer is under-billed by $60.00 on a single line. Quantity 1 is correct (tax $20.00 on $100.00), which is why the bug is invisible on the simplest test case and hides in the multiple. This is not confined to newly created invoices: the same relationship holds across the whole seeded book. VC-1000 (3 × $527.84, taxRate 0.2) stores subtotal $1583.52 but tax $105.57 — exactly 20% of the unit price, where 20% of the subtotal is $316.70. The error scales with quantity: at qty 4 the merchant collects one quarter of the tax it invoices for.

| | |
|---|---|
| **Expected** | For qty 4, unitPrice 100.00, taxRate 0.20: subtotal 400.00, tax 80.00 (0.20 × 400.00), total 480.00. Generally tax = subtotal × taxRate. |
| **Actual** | subtotal 400.00, tax 20.00 (0.20 × unitPrice only), total 420.00. Confirmed identically in the fixture data: inv_00021 / VC-1000 has subtotal 1583.52, taxRate 0.2, tax 105.57, total 1689.09. |
| **Impact** | Every multi-quantity invoice this product issues under-charges tax, and the shortfall grows with quantity. The business collects less than it owes its tax authority and less than it billed, and the discrepancy is invisible on the page because subtotal + tax does equal the printed total — the numbers look self-consistent while the rate is silently wrong. Reconciling and re-issuing a corrected invoice run is exactly the kind of incident that turns into a churn event for an invoicing SaaS. |
| **Reproduced** | 2/2 independent replays, each from a fresh seed |
| **Control build** | assertion did **not** fire — behaviour is specific to this build |
| **Observed value** | `420` |
| **Root defect** | `BUG-001` — Invoice tax is computed on unit price instead of line total (POST /api/invoices — recalcInvoice()) |

**Steps to reproduce**

1. Reset the app to the `default` fixture
2. Sign in as **primary** (password + emailed OTP)
3. Open `/app`
4. Click `#new-invoice`
5. {"op":"selectOption","selector":"#customer","label":"Acme Robotics"}
6. Type `QA tax probe qty4` into `#description`
7. Type `4` into `#qty`
8. Type `100` into `#unitPrice`
9. Click `#save-invoice`
10. Wait 800ms
11. `GET /api/invoices?search=QA%20tax%20probe%20qty4` as **primary**

**Automated check** — this finding is recorded as present when `invoices.0.total` in the response body is not `480`.


**Evidence** — [screenshot at failure](evidence/verify/03-core-flows/screenshots/004-assert.png) · [step trace](evidence/verify/03-core-flows/steps.jsonl) · [Playwright trace](evidence/verify/03-core-flows/trace.zip) · [agent session video](evidence/agents/core-flows/video/page@71963a63ebe9f0a8ef398da702bbc6df.webm) · [agent screenshot](evidence/agents/core-flows/screenshots/010-click.png)

<sub>Agent self-reported confidence was 97%; the confidence above is computed from replay outcomes, not from the agent.</sub>


### 3. Deleting a customer that still has invoices leaves the invoice list stuck on "Loading…" forever — 260 invoices exist, zero are rendered

**✅ CONFIRMED** · severity **critical** · confidence **90%** · dimension `data-integrity`

Deleting a customer who still has invoices orphans those invoices (the API starts returning `customer: null` for them). The /app invoice list cannot render a null customer, so it never leaves its loading state: the table shows a single "Loading…" row, the header count is replaced by "Loading…", and no error is displayed. GET /api/invoices still returns 200 with total = 260 and every invoice intact, so the server is healthy and only the product surface is dead. It does not recover on a hard reload — the list stays permanently blank until the data is fixed. Deleting a customer that has NO invoices leaves the list perfectly healthy, which isolates the trigger to orphaned invoices.

| | |
|---|---|
| **Expected** | After deleting Northwind Traders, /app should still list all 260 invoices, showing the ex-customer's invoices with something like "(deleted customer)" in the customer column — exactly what the confirmation dialog promises: "Their invoices stay on the account." |
| **Actual** | /app renders one table row containing the text "Loading…" and never resolves. The invoice count in the header also reads "Loading…". No console error, no error banner, no retry. Meanwhile GET /api/invoices?page=1 returns 200, total=260, invoices[0].number="VC-1000", invoices[0].customer=null. |
| **Impact** | A single routine housekeeping action — deleting a customer you no longer bill — makes every invoice in the account invisible, with no warning and no error to explain it. Journeys B (browse/search/filter), C (open an invoice), D (mark as paid) and any invoice review become impossible from the UI; billing work stops. Because there is no error message, the user's rational conclusion is "the delete wiped my invoices", which is a data-loss support ticket and likely a churn event, even though the data is actually still there. |
| **Reproduced** | 2/2 independent replays, each from a fresh seed |
| **Control build** | assertion did **not** fire — behaviour is specific to this build |
| **Observed value** | `2` |
| **Root defect** | `BUG-003` — Deleting a customer orphans invoices and crashes the invoice list (DELETE /api/customers/:id + GET /api/invoices) |

**Steps to reproduce**

1. Reset the app to the `default` fixture
2. Sign in as **primary** (password + emailed OTP)
3. `DELETE /api/customers/cus_00005` as **primary**
4. Open `/app`
5. Wait 2000ms

**Automated check** — this finding is recorded as present when the text "Loading…" is present.

**Console during replay**

```
Cannot read properties of null (reading 'name')
```

**Evidence** — [screenshot at failure](evidence/verify/08-data-integrity/screenshots/002-assert.png) · [step trace](evidence/verify/08-data-integrity/steps.jsonl) · [Playwright trace](evidence/verify/08-data-integrity/trace.zip) · [agent session video](evidence/agents/data-integrity/video/page@15827b6a4c3aed542188ce112f0be115.webm) · [agent screenshot](evidence/agents/data-integrity/screenshots/025-click.png)

<sub>Agent self-reported confidence was 95%; the confidence above is computed from replay outcomes, not from the agent.</sub>


### 4. "Mark as paid" button is pushed 167px off the right edge of the screen at 375px phone width, making the invoice detail dialog's only primary action unreachable

**✅ CONFIRMED** · severity **critical** · confidence **90%** · dimension `perf-visual`

The invoice detail dialog is a fixed 560px-wide box that does not reflow for narrow viewports. At 375×812 (a standard phone size) the dialog's right edge sits at x=560 against a 375px-wide viewport, and its "Mark as paid" button (x=416–542) is almost entirely off-screen — 167px past the visible viewport edge.

| | |
|---|---|
| **Expected** | On a 375px-wide viewport, the detail dialog should fit within the screen (or scroll vertically within itself) so its "Mark as paid" button is visible and tappable without any horizontal scrolling. |
| **Actual** | inspect_element on #mark-paid at 375×812 reports rect {x:416, width:126, right:542}, viewport width 375, overflowPx 167. The dialog container div.modal itself reports width 560 against the 375px viewport (overflowPx 185). Screenshot confirms only the left portion of the dialog is visible; the button is not shown. |
| **Impact** | A user trying to record a payment from their phone — the 'Get paid' journey, arguably the app's core revenue action — cannot see or tap the button that does it. There is no visible scroll affordance suggesting more content exists off to the right, so most users would conclude the feature is simply missing on mobile. |
| **Reproduced** | 2/2 independent replays, each from a fresh seed |
| **Control build** | assertion did **not** fire — behaviour is specific to this build |
| **Observed value** | `{"elementRight":542,"elementWidth":126,"viewportWidth":375,"overflowPx":167}` |
| **Root defect** | `BUG-008` — Invoice modal overflows a 375px viewport; Save is unreachable (invoice editor modal CSS) |

**Steps to reproduce**

1. Reset the app to the `default` fixture
2. Sign in as **primary** (password + emailed OTP)
3. Open `/app`
4. Resize viewport to 375×812
5. Click `tr.clickable:nth-of-type(3)`
6. {"op":"waitForText","text":"Mark as paid"}

**Automated check** — this finding is recorded as present when `#mark-paid` extends past the viewport edge.


**Evidence** — [screenshot at failure](evidence/verify/13-perf-visual/screenshots/003-assert.png) · [step trace](evidence/verify/13-perf-visual/steps.jsonl) · [Playwright trace](evidence/verify/13-perf-visual/trace.zip) · [agent session video](evidence/agents/perf-visual/video/page@64f0ebd7f7c81d2bf15b8ce2cf83919d.webm) · [agent screenshot](evidence/agents/perf-visual/screenshots/026-click.png)

<sub>Agent self-reported confidence was 95%; the confidence above is computed from replay outcomes, not from the agent.</sub>


### 5. Invoice search takes ~4 seconds server-side while the unfiltered list returns in ~1ms

**✅ CONFIRMED** · severity **high** · confidence **95%** · dimension `core-flows` · independently reported by 2 agents

GET /api/invoices?search=Acme took 3,808ms, against 1–2ms for the same endpoint with no search term on the same 260-invoice dataset. In the UI this means clicking Search leaves the table empty for several seconds: measured from the browser, the results table still had zero rows at 2,000ms after the click and only populated somewhere between 2s and 3s. There is no spinner or "Searching…" state during that window on the results themselves, so the intermediate state is indistinguishable from "no invoices matched". Finding an invoice is the single most repeated action in an invoicing tool, and a four-second round trip on a 260-row table will not survive a real customer's book of several thousand.

| | |
|---|---|
| **Expected** | A keyword search over a few hundred invoices should return in well under 500ms, comparable to the unfiltered list. |
| **Actual** | GET /api/invoices?search=Acme responded in 3,808ms; the UI table remained empty at the 2-second mark and only rendered rows after ~3 seconds. |
| **Impact** | Every lookup of a specific invoice — the core daily task — stalls for several seconds, and during the stall the screen reads as "nothing found", so users retype or re-search and make it worse. On a larger tenant this is the difference between a usable product and one people abandon for a spreadsheet. |
| **Reproduced** | 2/2 independent replays, each from a fresh seed |
| **Control build** | assertion did **not** fire — behaviour is specific to this build |
| **Observed value** | `3204` |
| **Root defect** | `BUG-007` — Invoice search is quadratic and exceeds a 2s budget (GET /api/invoices?search=) |

**Steps to reproduce**

1. Reset the app to the `default` fixture
2. Sign in as **primary** (password + emailed OTP)
3. `GET /api/invoices?search=Acme` as **primary**

**Automated check** — this finding is recorded as present when the response time in ms is greater than `2000`.


**Evidence** — [screenshot at failure](evidence/verify/05-core-flows/screenshots/001-assert.png) · [step trace](evidence/verify/05-core-flows/steps.jsonl) · [Playwright trace](evidence/verify/05-core-flows/trace.zip) · [agent session video](evidence/agents/core-flows/video/page@71963a63ebe9f0a8ef398da702bbc6df.webm) · [agent screenshot](evidence/agents/core-flows/screenshots/010-click.png)

<sub>Agent self-reported confidence was 93%; the confidence above is computed from replay outcomes, not from the agent.</sub>


### 6. Quantity field in the invoice editor has no accessible name

**✅ CONFIRMED** · severity **high** · confidence **90%** · dimension `accessibility`

The #qty number input in the New invoice form has no <label for>, no wrapping label, and no aria-label — a screen reader announces it as an unlabeled number spinbutton.

| | |
|---|---|
| **Expected** | Every input a user must fill in should announce a name a screen reader can speak, e.g. "Quantity, number input". |
| **Actual** | inspect_element and check_probe both resolve accessibleName/contentName to null for #qty: labelFor null, wrappedInLabel false, ariaLabel null, ariaLabelledby null. |
| **Impact** | A screen reader user opening "New invoice" hits a number field with no announced purpose. They can infer it from visual position (next to a styled column header) but not from the accessibility tree, so they cannot fill the form confidently or at all without sighted help. |
| **Reproduced** | 2/2 independent replays, each from a fresh seed |
| **Control build** | assertion did **not** fire — behaviour is specific to this build |
| **Observed value** | `{"id":"qty","hasLabelFor":false,"wrappedInLabel":false,"ariaLabel":null,"ariaLabelledby":null,"title":null,"namesFromOwnContent":false,"contentName":null,"accessible":false}` |
| **Root defect** | `BUG-006` — Amount field has no programmatic label and errors are not announced (invoice editor form) |

**Steps to reproduce**

1. Reset the app to the `default` fixture
2. Sign in as **primary** (password + emailed OTP)
3. Open `/app`
4. Click `#new-invoice`

**Automated check** — this finding is recorded as present when `#qty` has no programmatic accessible name.


**Evidence** — [screenshot at failure](evidence/verify/10-accessibility/screenshots/003-assert.png) · [step trace](evidence/verify/10-accessibility/steps.jsonl) · [Playwright trace](evidence/verify/10-accessibility/trace.zip) · [agent session video](evidence/agents/accessibility/video/page@5bd0cabf3f36817b1081b27b69fab905.webm) · [agent screenshot](evidence/agents/accessibility/screenshots/016-click.png)

<sub>Agent self-reported confidence was 95%; the confidence above is computed from replay outcomes, not from the agent.</sub>


### 7. OTP has no attempt limiting: 10 wrong codes then the correct code still logs in

**✅ CONFIRMED** · severity **high** · confidence **88%** · dimension `auth-access`

After a valid password issues an OTP challenge, the 6-digit code can be guessed without limit. Submitting ten consecutive wrong codes never locks the challenge or the account: an 11th wrong code still returns 401 'invalid' (not a lockout status), and the correct code submitted after ten wrong attempts logs the user straight in (200).

| | |
|---|---|
| **Expected** | After a small number of wrong OTP codes the challenge should be invalidated / the account temporarily locked (e.g. 423/429), so a 6-digit code cannot be brute-forced. |
| **Actual** | startLogin (correct password) → submitOtp with a wrong code x10 → submitOtp with the correct code returns 200 and completes login. A 12th attempt with another wrong code still returns 401 rather than a locked state, confirming attempts are unlimited. |
| **Impact** | A 6-digit OTP with no attempt limiting is brute-forceable — an attacker who has a user's password (or after a leak) can iterate codes and take over the account, defeating the point of the second factor. |
| **Reproduced** | 2/2 independent replays, each from a fresh seed |
| **Control build** | assertion did **not** fire — behaviour is specific to this build |
| **Observed value** | `200` |
| **Root defect** | `BUG-004` — OTP challenge never expires and has no attempt limit (POST /api/auth/verify-otp) |

**Steps to reproduce**

1. Reset the app to the `default` fixture
2. {"op":"startLogin","as":"primary"}
3. {"op":"submitOtp","code":"000000","times":10}
4. {"op":"submitOtp","code":"correct"}

**Automated check** — this finding is recorded as present when the response status is `200`.


**Evidence** — [step trace](evidence/verify/02-auth-access/steps.jsonl) · [agent session video](evidence/agents/auth-access/video/page@68974b84708a4e41f621d01099381b69.webm) · [agent screenshot](evidence/agents/auth-access/screenshots/002-open_app.png)

<sub>Agent self-reported confidence was 85%; the confidence above is computed from replay outcomes, not from the agent.</sub>

## Experience review

Judgement, not defects. Nothing in this section is probe-verified, it is kept out of the defect count and out of the false-positive rate, and it is what the agents thought of actually using the product. Read it as a review, not as a bug list.

### Journey scorecard

| Journey | Score | Rated by | What the agents said |
|---|---|---|---|
| E — Bill someone | ★★☆☆☆ 1.5 | 2 agent(s) | The flow completes but produces a financially wrong invoice for any quantity above 1, with no preview beforehand and no confirmation afterwards. · Two of four form fields (quantity, unit price) have zero accessible name, |
| F — Manage customers | ★★☆☆☆ 2.0 | 1 agent(s) | Add and delete are crisp and the count updates live, but the confirmation makes a promise about invoices that the product immediately breaks. |
| B — Find an invoice | ★★☆☆☆ 2.3 | 4 agent(s) | Filtering and pagination are logically sound, but a ~4s search that renders as an empty table makes the most common task feel broken. · One customer deletion makes the entire 260-invoice list render nothing at all, forev |
| D — Get paid | ★★★☆☆ 2.5 | 2 agent(s) | Marking paid is instant and persists correctly through the API and the status filter; only the row behind the open dialog lags. · The 'Mark as paid' button is 167px off-screen at 375px width with no visible way to reach  |
| A — Sign in | ★★★☆☆ 3.0 | 2 agent(s) | Correct password-first ordering and clean unauthenticated refusal, but the OTP step has no attempt limiting, which is a real security gap in the core sign-in path. · Email + password → 6-digit code works and is quick, bu |
| C — Inspect an invoice | ★★★☆☆ 3.3 | 4 agent(s) | A clear, well-structured breakdown that unfortunately prints a tax figure contradicting its own stated 20% rate, and cannot be dismissed with Escape. · Row click opens a fast, well-labelled, correctly sized dialog — but  |

### Recommendations, worst friction first

**🔴 major · E — Bill someone** <sub>— `core-flows`</sub>

Save closes the modal onto an unchanged page 1 and says nothing. I could not tell from the screen whether I had just billed a client or lost the form. The new invoice sorts to the end of 14 pages, so it is genuinely unreachable without a search that takes four seconds.

> **Suggested change.** On success, show a toast naming the invoice ("VC-1260 created for Acme Robotics — $480.00") with a "View" link that opens its detail dialog, and default the list sort to newest-first so freshly created work is the first thing on screen.

**🔴 major · B — Find an invoice** <sub>— `core-flows`</sub>

Clicking Search empties the table and leaves it empty for two to three seconds with no indication that anything is happening. For most of that window the screen is indistinguishable from a search that matched nothing, which made me doubt correct results more than once during this pass.

> **Suggested change.** Keep the previous rows visible with a dimmed overlay and an explicit "Searching…" label while the request is in flight, and never render the zero-row state until a response has actually arrived. Then fix the underlying 3.8s query.

**🔴 major · F — Manage customers** <sub>— `data-integrity`</sub>

The delete confirmation says "Delete this customer? Their invoices stay on the account." That is a factual promise the product then breaks — the invoices technically remain in the database but become completely unreachable in the UI. The dialog also gives no indication that this particular customer has ~22 invoices attached; a customer with zero invoices and a customer with two years of billing history get the identical prompt.

> **Suggested change.** Make the confirmation data-aware: "Delete Northwind Traders? They have 22 invoices, which will stay on the account but will no longer be linked to a customer." Better still, offer "Archive" as the default action for customers with invoices and reserve hard delete for customers with none.

**🔴 major · B — Find an invoice** <sub>— `data-integrity`</sub>

When the list fails it shows the word "Loading…" indefinitely — in the table body AND in place of the "260 invoice(s)" header count. There is no timeout, no error state, no retry affordance, and nothing in the browser console either. As a tester I could not tell from the screen whether the data was slow, gone, or my session had expired.

> **Suggested change.** Give the list an explicit failure state after a short timeout: "We couldn't load your invoices" with a Retry button and a request id. Never leave a skeleton/loading state as the terminal state, and never replace a known count with a spinner — keep the last known count visible while refreshing.

**🔴 major · E — Bill someone** <sub>— `accessibility`</sub>

Filling out the New invoice form, the Quantity and Unit price boxes sit directly under plain-text column headers ("Quantity", "Unit price") that look exactly like labels but aren't programmatically tied to the inputs. Visually the form reads as fully labelled; only probing the accessibility tree reveals two of the four fields are anonymous.

> **Suggested change.** Wrap those header texts in <label for="qty"> / <label for="unitPrice"> (matching how Description and Customer are already done correctly) so the visual design doesn't have to change at all.

**🔴 major · B — Find an invoice** <sub>— `perf-visual`</sub>

Browsing the unfiltered list, paginating, and filtering by status are all effectively instant (2–4ms server responses). But the search box — the tool a user reaches for specifically to find one invoice among 260 — takes 2.5–3 seconds every time, with no loading spinner or disabled-state feedback on the Search button while it works. The contrast makes it feel like search is broken rather than just slow.

> **Suggested change.** Fix the underlying query (it's not correlated with result-set size — 'milestone' matched most of the table and 'Cedar' matched a handful, and both took ~2.6-3s, suggesting an unindexed scan rather than a payload-size problem) and add a visible loading state on the Search button/input so users get feedback during the wait.

**🔴 major · D — Get paid** <sub>— `perf-visual`</sub>

Beyond the off-screen button itself (reported as a defect), there is no horizontal scroll indicator, drag hint, or any visual cue on the 375px view that more of the dialog exists to the right. A user has no reason to suspect scrolling would help, so in practice the feature reads as absent on phones, not merely hard to reach.

> **Suggested change.** This reinforces that the fix should be a responsive reflow (stack fields, shrink dialog to viewport width) rather than relying on users discovering a horizontal-scroll workaround.

**🟠 moderate · A — Sign in** <sub>— `auth-access`</sub>

The OTP challenge accepts unlimited guesses with no visible throttle, backoff, or 'attempts remaining' feedback. Even setting aside the security defect, a user who fat-fingers the code gets no signal about how many tries they have or whether the code has expired.

> **Suggested change.** Add a lockout after ~5 wrong codes and surface it: 'Too many attempts — request a new code.' This both fixes the brute-force hole and tells the user what to do next instead of letting them guess forever.

**🟠 moderate · E — Bill someone** <sub>— `core-flows`</sub>

The New invoice modal never shows the money it is about to commit. I typed quantity 4 and unit price 100 and saved, with no subtotal, tax or total anywhere on the form — the first time any figure appeared was in the saved record, where it was wrong. A live preview would have made the tax defect obvious to the person creating the invoice rather than to their client three weeks later.

> **Suggested change.** Add a live running total under the unit price field: "Subtotal $400.00 · Tax (20%) $80.00 · Total $480.00", recomputed on each keystroke. It costs one small block of markup and turns every user into a check on the arithmetic.

**🟠 moderate · A — Sign in** <sub>— `core-flows`</sub>

Midway through my first end-to-end run the session died without warning. The Save on a fully filled-in invoice form came back "Could not save invoice (not_authenticated)", the list behind it froze on "Loading…" permanently, and a reload dropped me at the sign-in screen with the invoice content gone. I could not reproduce this on demand, so I am not filing it as a defect, but the failure mode is worth designing against regardless.

> **Suggested change.** Treat a 401 from a save as a recoverable state rather than an error string: preserve the form contents, re-authenticate, and retry the submission — and never leave the list stuck on "Loading…" after a failed fetch; render an error with a retry control instead.

**🟠 moderate · B — Find an invoice** <sub>— `data-integrity`</sub>

260 invoices at 20 per page is 13 pages, and the only controls are Previous/Next. There is no page indicator, no jump-to-page, and no sense of where you are in the set. Finding an invoice from a few months back means blind-clicking Next.

> **Suggested change.** Add "Page 3 of 13" between the buttons and a page-size selector; even better, make the header count clickable to jump to the last page. Sorting by date/amount would remove most of the paging need entirely.

**🟠 moderate · A — Sign in** <sub>— `data-integrity`</sub>

Once the app got into the broken state, subsequent navigations silently redirected me to /login with a fresh, blank "Sign in to Ledgerly" form and no explanation. Being sent to login when unauthenticated is correct, but arriving there with no message at all — after having been signed in a moment earlier — reads as "the app logged me out at random".

> **Suggested change.** When a redirect to /login is caused by an expired or invalidated session, carry a message ("Your session expired — please sign in again") and return the user to the page they were on after they re-authenticate.

**🟠 moderate · E — Bill someone** <sub>— `accessibility`</sub>

Submitting the form with a missing description/price shows an inline error, but nothing about the interaction (focus movement, ARIA live region, field description) tells an assistive-tech user that submission failed or why. The modal just silently grows a few pixels taller.

> **Suggested change.** On validation failure, move focus to the first invalid field and add aria-describedby pointing at its error text, or wrap the error text in a role="alert" region so screen reader users get an audible signal the moment it appears.

**🟠 moderate · general** <sub>— `perf-visual`</sub>

Both dialogs on this app (New Invoice and Invoice Detail) share one fixed 560px-wide modal component with no responsive breakpoint, which is why the same 167px overflow shows up in two different journeys (E and D) at the same phone width.

> **Suggested change.** Since it's a shared component, a single CSS fix (max-width: 100vw / min(560px, 100vw) plus internal padding adjustments) would resolve the overflow for both the New Invoice and Mark as Paid actions at once.

**🟡 minor · D — Get paid** <sub>— `core-flows`</sub>

"Mark as paid" is immediate and it sticks — the status flipped in the dialog and, after a reload, the invoice correctly dropped out of the Open filter. The one rough edge is that the list behind the dialog does not repaint while the dialog is still up, so for as long as you leave it open the row underneath contradicts the dialog on top of it.

> **Suggested change.** Update the row behind the dialog optimistically the moment the status change succeeds, so closing the dialog never reveals a stale row.

**🟡 minor · B — Find an invoice** <sub>— `core-flows`</sub>

The list header reads "260 invoice(s)" but the table gives no indication of which page of how many you are on — just Previous and Next. With 13 pages of near-identical descriptions, I repeatedly lost track of where I was while paginating.

> **Suggested change.** Show "Showing 21–40 of 260 · page 2 of 13" beside the pager, and put the page number in the URL so a position can be bookmarked and restored.

**🟡 minor · B — Find an invoice** <sub>— `perf-visual`</sub>

At 375px width the invoice list keeps its full desktop table structure rather than reflowing to a card/stacked layout. It's still readable, but the description column is truncated hard (e.g. 'VC-1008 Professional services engagement for Harbor & Co — m...') and there's no way to see the rest without opening the invoice.

> **Suggested change.** On narrow viewports, drop the long description column from the table (or wrap it) and lead with invoice number, customer, and total — the fields a user actually scans for.

### Working well — do not regress

- **A — Sign in** — The login handshake is well-structured: a wrong password issues no OTP challenge at all (startLogin with password 'wrong' produced no challenge), so the code step is only reachable after the first factor passes. That is the correct order and prevents leaking OTPs to unauthenticated guessers.
- **A — Sign in** — Unauthenticated API requests are cleanly refused (GET /api/invoices/:id as no session → 401 not_authenticated), and the /app route renders the sign-in form rather than any app chrome when there is no session.
- **C — Inspect an invoice** — The detail dialog itself is well built: it names the customer, restates quantity and unit price, and breaks out subtotal, tax and total on separate lines with the rate in the tax label. That breakdown is exactly what makes an invoice auditable — and it is the only reason I could catch the tax bug by eye at all.
- **B — Find an invoice** — Status filtering and pagination held together well. Filtering to Paid updated both the rows and the "N invoice(s)" header, and searching while on page 3 correctly reset to page 1 and returned results rather than showing a confusing empty page. Previous is properly disabled on page 1.
- **E — Bill someone** — Input validation on the invoice payload is genuinely solid: quantity 0, quantity −5 and a non-numeric quantity are all rejected with 400 rather than silently creating a $0 or negative-value invoice. That is the boundary behaviour I was expecting to find broken and did not.
- **C — Inspect an invoice** — Clicking a table row opens the detail dialog instantly, with no navigation and no loading flash, and the dialog is marked up properly (role="dialog", aria-labelledby pointing at the invoice title, a real Close button). It fits the viewport with no overflow at 1280×800. The rows also carry good accessible names ("Open invoice VC-1000").
- **F — Manage customers** — The customers page itself behaves well on delete: the row disappears immediately and the header count updates from "12 customer(s)" to "11 customer(s)" without a reload. The contrast with the invoice list is stark — the same delete leaves one page crisp and the other permanently broken.
- **C — Inspect an invoice** — Keyboard-only flow to open an invoice works cleanly: Tab from "New invoice" lands on the first table row with a visible focus ring, and Enter opens the detail dialog immediately. The dialog also carries a proper role="dialog" and aria-labelledby pointing at its visible title.
- **B — Find an invoice** — Search box and status filter both expose clear, correct accessible names ("Search invoices", "Filter by status") distinct from their visible placeholder/label text, so a screen reader user can find and use them without guessing.
- **C — Inspect an invoice** — On desktop, the detail dialog is clean and complete — customer, line item, subtotal, tax and total are all clearly laid out and match the API response exactly.

## Claims that did not survive verification

Every agent claim is replayed twice from a fresh seed and once against a known-good control build. These did not hold up and were kept out of the findings above. They are listed so the suppression is auditable rather than invisible.

| Claim | Dimension | Reason withheld | Replays |
|---|---|---|---|
| After saving a new invoice, nothing on screen shows that it was created | `core-flows` | the same assertion also fires on the known-good build, so it describes intended behaviour or harness noise | 2/2 |
| Escape does not close the invoice detail dialog | `core-flows` | the same assertion also fires on the known-good build, so it describes intended behaviour or harness noise | 2/2 |

## What was exercised and found working

Silence is ambiguous, so each agent reports what it deliberately checked and found healthy.

**Authentication & Access Control** (`claude-opus-5`)

- Unauthenticated read is refused: GET /api/invoices/inv_00281 with no session returns 401 not_authenticated.
- Cross-tenant WRITE is blocked: POST /api/invoices/inv_00281/pay as primary returns 404 (route exists but tenant-scoped).
- Cross-tenant DELETE is blocked: DELETE /api/invoices/inv_00281 as primary returns 404.
- Cross-tenant customer read is blocked: GET /api/customers/cus_00017 (foreign customer) as primary returns 404.
- Invoice list and search are tenant-scoped: search for the foreign number RI-1000 as primary returns an empty result set (total 0).
- Password is validated before OTP: startLogin with a wrong password issues no OTP challenge, so the code step is unreachable without the first factor.
- The secondary/owning tenant can read its own invoice inv_00281 (200), confirming the primary 200 is a genuine cross-tenant leak and not a broken fixture.

**Core Business Flows** (`claude-opus-5`)

- Quantity-1 invoice arithmetic: 1 × $100.00 at 20% saves tax $20.00 and total $120.00 — correct
- Detail dialog internal consistency: displayed subtotal + displayed tax equals the displayed total on every invoice inspected
- Journey D (mark as paid): status flips in the dialog and persists — GET /api/invoices/inv_00023 returns "paid" after the UI action
- Journey D list consistency after reload: a newly paid invoice correctly disappears from the Open status filter
- Status filter (All / Open / Paid) updates both the table rows and the "N invoice(s)" count header — no stale count left behind
- Search combined with pagination: searching while on page 3 correctly resets to page 1 and returns 20 matching rows rather than an empty page
- Server-side search correctness: GET /api/invoices?search=Acme%20Robotics returns total 22, matching the invoices whose descriptions name that customer
- Double submit of the invoice form: the modal closes on the first Save click and the Save button becomes unavailable, so a rapid second click cannot fire — no duplicate invoice was created
- Journey E customer selection: select_option on the #customer dropdown binds the correct customer id (cus_00006 / Acme Robotics) onto the saved record
- Pagination controls: Previous is correctly disabled on page 1 and Next advances the list
- Invoice list totals column agrees with the stored total field returned by the API for every row checked

**Data Integrity & Destructive Edges** (`claude-opus-5`)

- GET /api/invoices remains 200 with total=260 and every invoice object intact after a customer is deleted — the server-side data really is preserved, only the UI fails
- Deleting a customer that has NO invoices: the invoice list continues to render all 20 rows normally, isolating the defect to orphaned invoices
- POST /api/invoices with qty 0 → rejected with 400 (no zero-value invoice created)
- POST /api/invoices with qty -5 → rejected with 400 (no negative-value invoice created)
- POST /api/invoices with a non-numeric qty ("abc") → rejected with 400
- Customer delete on /customers: confirm dialog appears, row is removed, and the header count updates 12 → 11 without a reload
- /customers page continues to load and function normally after a customer with invoices is deleted (only /app breaks)
- Invoice list vs API agreement in the healthy state: header says "260 invoice(s)", 20 rows render on page 1, API total = 260
- Detail dialog (journey C) opens on row click, has role=dialog with aria-labelledby, a working Close button, and no viewport overflow at 1280×800
- Tenant separation of the two seeded orgs at the list level: secondary user sees only their own 8 RI-* invoices while primary sees 260 VC-* invoices
- Sign out (journey G) clears the session and lands on /login

**Accessibility & Form Semantics** (`claude-sonnet-5`)

- Search input (#search) has accessible name "Search invoices" via label association.
- Status filter <select> (#status-filter) has accessible name "Filter by status".
- Customer <select> (#customer) on the invoice form has accessible name "Customer" via a real <label for>.
- Description input (#description) on the invoice form has accessible name "Description" via a real <label for>.
- Invoice list rows (tr.clickable) are keyboard-focusable (Tab reaches them, focusVisible:true), carry role="button", and have a descriptive aria-label ("Open invoice VC-1000", etc.) rather than relying on visible text alone.
- Keyboard-only row activation works end-to-end: Tab to a row then Enter opens the invoice detail dialog (#detail-close present afterward) — verified via check_probe on a fresh session.
- The invoice detail dialog has role="dialog" and resolves a non-empty accessible name via aria-labelledby="detail-title" (verified authoritatively via check_probe, contradicting an earlier stale reading from inspect_element in a longer-lived session).
- The New invoice dialog likewise has role="dialog" and resolves a non-empty accessible name via aria-labelledby="modal-title" on a fresh check_probe run.
- Cancel, Save invoice, and Close buttons all expose clear, correct accessible names ("Cancel", "Save invoice", "Close").

**Responsive Layout & Performance** (`claude-sonnet-5`)

- Unfiltered invoice list (GET /api/invoices) responds in ~2ms
- Status filter (GET /api/invoices?status=open and ?status=paid) responds in 2-3ms
- Pagination controls render correctly (Previous disabled on page 1, Next enabled, perPage=20)
- Search returns the correct filtered result set (only slow, not incorrect)
- Invoice detail dialog on desktop viewport renders full invoice data correctly (customer, qty, unit price, subtotal, tax, total) matching the API response
- New Invoice modal's Cancel button closes the dialog cleanly on desktop and phone viewports
- Invoice list and detail dialog render correctly and match API data on a second tenant (secondary/Rival Industries), confirming the perf/layout behavior isn't fixture-specific

## Agent roster

| Dimension | Model | Turns | Tool calls | Defect claims | Experience notes | Duration | Cost |
|---|---|---|---|---|---|---|---|
| Authentication & Access Control | `claude-opus-5` | 27 | 28 | 2 | 3 | 244s | $1.03 |
| Core Business Flows | `claude-opus-5` | 55 | 54 | 5 | 8 | 558s | $2.23 |
| Data Integrity & Destructive Edges | `claude-opus-5` | 69 | 68 | 2 | 7 | 500s | $3.27 |
| Accessibility & Form Semantics | `claude-sonnet-5` | 52 | 51 | 3 | 4 | 375s | $1.63 |
| Responsive Layout & Performance | `claude-sonnet-5` | 56 | 55 | 3 | 5 | 286s | $1.55 |

## Measurement appendix

The false-positive rate above is not self-assessed. Each published finding is replayed with exactly one seeded defect enabled at a time; a finding is counted as a true positive only when that oracle names the defect behind it. A published finding no defect explains is counted as a false positive even when it looks plausible.

```json
{
  "counts": {
    "rawClaims": 15,
    "afterDedupe": 14,
    "published": 7,
    "suppressed": 2,
    "confirmed": 7,
    "flaky": 0,
    "truePositives": 7,
    "falsePositives": 0
  },
  "attributionRan": true,
  "falsePositiveRatePct": 0,
  "unsuppressedFalsePositiveRatePct": 14.3,
  "suppressionYieldPct": 14.3,
  "recall": {
    "activeDefects": 8,
    "found": 7,
    "recallPct": 87.5,
    "foundIds": [
      "BUG-001",
      "BUG-002",
      "BUG-003",
      "BUG-004",
      "BUG-006",
      "BUG-007",
      "BUG-008"
    ],
    "missedIds": [
      "BUG-005"
    ]
  },
  "bySuppressionReason": {
    "CONTROL_ALSO_FIRES": 2
  },
  "byDimension": {
    "auth-access": {
      "reported": 2,
      "published": 2,
      "confirmed": 2,
      "suppressed": 0,
      "truePositives": 2
    },
    "core-flows": {
      "reported": 4,
      "published": 2,
      "confirmed": 2,
      "suppressed": 2,
      "truePositives": 2
    },
    "data-integrity": {
      "reported": 1,
      "published": 1,
      "confirmed": 1,
      "suppressed": 0,
      "truePositives": 1
    },
    "accessibility": {
      "reported": 1,
      "published": 1,
      "confirmed": 1,
      "suppressed": 0,
      "truePositives": 1
    },
    "perf-visual": {
      "reported": 1,
      "published": 1,
      "confirmed": 1,
      "suppressed": 0,
      "truePositives": 1
    }
  },
  "byModel": {
    "claude-opus-5": {
      "reported": 7,
      "published": 5,
      "truePositives": 5,
      "suppressed": 2,
      "falsePositiveRatePct": 0
    },
    "claude-sonnet-5": {
      "reported": 2,
      "published": 2,
      "truePositives": 2,
      "suppressed": 0,
      "falsePositiveRatePct": 0
    }
  },
  "honeypotsInPlace": 5
}
```

### Seeded defects this run did not surface

- `BUG-005` — Double-submitting the invoice form creates duplicate invoices _(expected owner: `core-flows`)_

<sub>Active seeded defects in the target build: BUG-001, BUG-002, BUG-003, BUG-004, BUG-005, BUG-006, BUG-007, BUG-008.</sub>
