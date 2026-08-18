// Honest self-measurement.
//
// A published finding is a true positive only if the oracle can attribute it to
// a specific seeded defect. Anything published that cannot be attributed counts
// against us, even when it looks plausible — the conservative direction, because
// the false-positive rate is the number that decides whether a pilot survives.
import { SUPPRESSED, VERDICTS } from './verify.js';

const pct = (n, d) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);

export function score({ raw, deduped, verified, activeBugs, honeypots, attributed = true }) {
  const published = verified.filter((f) => !SUPPRESSED.has(f.verdict));
  const suppressed = verified.filter((f) => SUPPRESSED.has(f.verdict));

  const truePositives = published.filter((f) => f.attributedBug);
  const falsePositives = published.filter((f) => !f.attributedBug);

  const foundBugs = new Set(truePositives.map((f) => f.attributedBug));
  const missed = activeBugs.filter((b) => !foundBugs.has(b));

  const byDimension = {};
  for (const f of verified) {
    const d = (byDimension[f.dimension] ??= { reported: 0, published: 0, confirmed: 0, suppressed: 0, truePositives: 0 });
    d.reported += 1;
    if (SUPPRESSED.has(f.verdict)) d.suppressed += 1; else d.published += 1;
    if (f.verdict === VERDICTS.CONFIRMED) d.confirmed += 1;
    if (f.attributedBug) d.truePositives += 1;
  }

  const byModel = {};
  for (const f of verified) {
    const m = (byModel[f.model || 'unknown'] ??= { reported: 0, published: 0, truePositives: 0, suppressed: 0 });
    m.reported += 1;
    if (SUPPRESSED.has(f.verdict)) m.suppressed += 1; else m.published += 1;
    if (f.attributedBug) m.truePositives += 1;
  }
  for (const m of Object.values(byModel)) {
    m.falsePositiveRatePct = pct(m.published - m.truePositives, m.published);
  }

  const bySuppressionReason = suppressed.reduce((acc, f) => {
    acc[f.verdict] = (acc[f.verdict] ?? 0) + 1;
    return acc;
  }, {});

  return {
    counts: {
      rawClaims: raw.length,
      afterDedupe: deduped.length,
      published: published.length,
      suppressed: suppressed.length,
      confirmed: published.filter((f) => f.verdict === VERDICTS.CONFIRMED).length,
      flaky: published.filter((f) => f.verdict === VERDICTS.FLAKY).length,
      truePositives: truePositives.length,
      falsePositives: falsePositives.length,
    },
    attributionRan: attributed,
    // The headline number: of what we actually showed the customer, how much was
    // wrong. Only meaningful when the attribution oracle ran — without it every
    // finding is unattributed and the rate would read as a meaningless 100%.
    falsePositiveRatePct: attributed ? pct(falsePositives.length, published.length) : null,
    // What the same agents would have shipped with no verification layer at all.
    unsuppressedFalsePositiveRatePct: attributed ? pct(falsePositives.length + suppressed.length, deduped.length) : null,
    suppressionYieldPct: pct(suppressed.length, deduped.length),
    recall: {
      activeDefects: activeBugs.length,
      found: foundBugs.size,
      recallPct: attributed ? pct(foundBugs.size, activeBugs.length) : null,
      foundIds: [...foundBugs].sort(),
      missedIds: missed,
    },
    bySuppressionReason,
    byDimension,
    byModel,
    honeypotsInPlace: Object.keys(honeypots ?? {}).length,
  };
}
