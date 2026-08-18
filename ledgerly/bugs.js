// Ground-truth bug manifest for the Ledgerly demo app.
// Every seeded defect is toggleable so we can run the evaluator against a
// known-clean build and measure our own false-positive rate honestly.
export const BUG_IDS = [
  'BUG-001', 'BUG-002', 'BUG-003', 'BUG-004',
  'BUG-005', 'BUG-006', 'BUG-007', 'BUG-008',
];

export const GROUND_TRUTH = {
  'BUG-001': {
    dimension: 'core-flows',
    severity: 'high',
    title: 'Invoice tax is computed on unit price instead of line total',
    where: 'POST /api/invoices — recalcInvoice()',
    detect: 'Create a line item with qty > 1 and a tax rate; the tax and grand total are too low.',
  },
  'BUG-002': {
    dimension: 'auth-access',
    severity: 'critical',
    title: 'IDOR: GET /api/invoices/:id is not scoped to the caller org',
    where: 'GET /api/invoices/:id',
    detect: 'Log in as org A and request an invoice id belonging to org B; it returns 200 with the data.',
  },
  'BUG-003': {
    dimension: 'data-integrity',
    severity: 'high',
    title: 'Deleting a customer orphans invoices and crashes the invoice list',
    where: 'DELETE /api/customers/:id + GET /api/invoices',
    detect: 'Delete a customer that has invoices, then open the dashboard; list renders empty with a TypeError in console.',
  },
  'BUG-004': {
    dimension: 'auth-access',
    severity: 'critical',
    title: 'OTP challenge never expires and has no attempt limit',
    where: 'POST /api/auth/verify-otp',
    detect: 'Submit many wrong OTP codes; no lockout, and an old challenge still verifies after its stated expiry.',
  },
  'BUG-005': {
    dimension: 'core-flows',
    severity: 'medium',
    title: 'Double-submitting the invoice form creates duplicate invoices',
    where: 'POST /api/invoices — no idempotency key, submit button not disabled',
    detect: 'Click Save twice quickly; two identical invoices appear.',
  },
  'BUG-006': {
    dimension: 'accessibility',
    severity: 'medium',
    title: 'Amount field has no programmatic label and errors are not announced',
    where: 'invoice editor form',
    detect: 'The amount/qty inputs have no <label for> or aria-label; the validation error is not linked by aria-describedby and has no role=alert.',
  },
  'BUG-007': {
    dimension: 'perf-visual',
    severity: 'medium',
    title: 'Invoice search is quadratic and exceeds a 2s budget',
    where: 'GET /api/invoices?search=',
    detect: 'Search on a seeded org takes > 2000ms.',
  },
  'BUG-008': {
    dimension: 'perf-visual',
    severity: 'medium',
    title: 'Invoice modal overflows a 375px viewport; Save is unreachable',
    where: 'invoice editor modal CSS',
    detect: 'At 375x812 the modal is wider than the viewport and the Save button is off-screen.',
  },
};

// Behaviours that are CORRECT but frequently mis-reported as bugs.
// Used to score false positives, not to score recall.
export const HONEYPOTS = {
  'HP-1': 'Delete actions require a confirmation dialog (intentional friction, not a broken button).',
  'HP-2': 'An org with no invoices shows a "No invoices yet" empty state (correct, not a failed load).',
  'HP-3': 'The password field masks its input (correct, not a "value did not appear" failure).',
  'HP-4': 'Money is rounded to 2 decimals for display (correct, not a calculation error).',
  'HP-5': 'An expired/absent session redirects to /login (correct, not a crash).',
};

export function activeBugs() {
  const raw = process.env.LEDGERLY_BUGS ?? 'all';
  if (raw === 'all') return new Set(BUG_IDS);
  if (raw === 'none') return new Set();
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}
