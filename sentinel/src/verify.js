// False-positive suppression.
//
// An agent claiming a failure is a hypothesis, not a finding. Every claim is
// re-executed by this module, which the agents cannot influence:
//
//   1. Reproduction — replay the probe on the target build TWICE, each time from
//      a fresh seed in a fresh browser context. Non-deterministic claims surface
//      here as 1-of-2.
//   2. Negative control — replay the same probe against a known-good control
//      build. If the assertion also "fires" there, the probe is measuring
//      intended behaviour or harness noise, not a regression, and the finding is
//      suppressed. This is what catches the whole class of confidently-wrong
//      agent reports, and in production the control is the last-good release.
//   3. Attribution (optional) — replay with one seeded defect enabled at a time
//      to name the underlying defect, giving an oracle-backed recall number.
//
// Confidence is computed here, from replay outcomes. It is never taken from the
// agent, because the agent is the thing being checked.
import { runProbe } from './probe.js';

export const VERDICTS = {
  CONFIRMED: 'CONFIRMED',
  FLAKY: 'FLAKY',
  NOT_REPRODUCED: 'NOT_REPRODUCED',
  CONTROL_ALSO_FIRES: 'CONTROL_ALSO_FIRES',
  UNVERIFIABLE: 'UNVERIFIABLE',
};

/** Suppressed verdicts never reach the customer-facing findings list. */
export const SUPPRESSED = new Set([VERDICTS.NOT_REPRODUCED, VERDICTS.CONTROL_ALSO_FIRES, VERDICTS.UNVERIFIABLE]);

const isApiAssertion = (p) => ['httpStatus', 'jsonNumber', 'jsonEquals', 'responseTimeMs'].includes(p?.assert?.kind);

/** Stable signature so the same defect found by two agents collapses into one. */
export function signature(finding) {
  const a = finding.probe?.assert ?? {};
  const lastApi = [...(finding.probe?.steps ?? [])].reverse().find((s) => s?.op === 'api');
  const key = [
    a.kind,
    a.path ?? a.selector ?? a.text ?? a.matches ?? '',
    lastApi ? `${lastApi.method || 'GET'} ${String(lastApi.path).split('?')[0].replace(/\/[a-z]{3}_\d+/g, '/:id')}` : '',
  ].join('|');
  return key;
}

export function dedupe(findings) {
  const bySig = new Map();
  const rank = { critical: 4, high: 3, medium: 2, low: 1 };
  for (const f of findings) {
    const sig = signature(f);
    const prev = bySig.get(sig);
    if (!prev) { bySig.set(sig, { ...f, reportedBy: [f.dimension], signature: sig }); continue; }
    prev.reportedBy.push(f.dimension);
    if ((rank[f.severity] ?? 0) > (rank[prev.severity] ?? 0)) {
      Object.assign(prev, { severity: f.severity, title: f.title, summary: f.summary });
    }
  }
  return [...bySig.values()];
}

function confidenceFor({ reproCount, controlFired, hasScreenshot, probe }) {
  let c = 0.30;
  if (reproCount === 2) c += 0.35;
  else if (reproCount === 1) c += 0.10;
  if (controlFired === false) c += 0.18;
  if (hasScreenshot) c += 0.07;
  if (isApiAssertion(probe)) c += 0.05;   // deterministic assertions replay cleanly
  return Math.round(Math.min(0.99, c) * 100) / 100;
}

async function replay(probe, harness, browser, recorder) {
  await harness.seed('default');
  return runProbe(probe, { harness, browser, recorder });
}

export async function verifyFinding(finding, ctx) {
  const { target, control, browser, evidence, index } = ctx;
  const scope = `verify/${String(index).padStart(2, '0')}-${finding.dimension}`;
  const rec = evidence.recorder(scope, { trace: true, video: false });

  const runs = [];
  for (let i = 0; i < 2; i++) {
    runs.push(await replay(finding.probe, target, browser, i === 0 ? rec : null));
  }
  const errors = runs.filter((r) => r.error).map((r) => r.error);
  const reproCount = runs.filter((r) => r.held === true).length;

  let controlRun = null;
  if (reproCount > 0 && control) {
    controlRun = await replay(finding.probe, control, browser, null);
  }
  const controlFired = controlRun ? controlRun.held === true : null;

  let verdict;
  if (runs.every((r) => r.error)) verdict = VERDICTS.UNVERIFIABLE;
  else if (reproCount === 0) verdict = VERDICTS.NOT_REPRODUCED;
  else if (controlFired === true) verdict = VERDICTS.CONTROL_ALSO_FIRES;
  else if (reproCount === 1) verdict = VERDICTS.FLAKY;
  else verdict = VERDICTS.CONFIRMED;

  const manifest = rec.manifest();
  return {
    ...finding,
    verdict,
    reproCount,
    reproAttempts: 2,
    controlFired,
    observed: runs.find((r) => r.held !== null)?.observed ?? null,
    replayErrors: errors,
    confidence: confidenceFor({
      reproCount, controlFired,
      hasScreenshot: !!manifest.lastScreenshot,
      probe: finding.probe,
    }),
    consoleErrors: runs[0]?.consoleErrors?.slice(0, 5) ?? [],
    evidence: manifest,
  };
}

/**
 * Two agents can prove the same defect through different endpoints, which no
 * probe signature can detect. Once the oracle has named the underlying defect,
 * collapse those into one entry so the customer is not shown the same bug twice.
 */
export function mergeByAttribution(verified) {
  const rank = { critical: 4, high: 3, medium: 2, low: 1 };
  const byBug = new Map();
  const out = [];
  for (const f of verified) {
    if (!f.attributedBug) { out.push(f); continue; }
    const prev = byBug.get(f.attributedBug);
    if (!prev) { byBug.set(f.attributedBug, f); out.push(f); continue; }
    prev.reportedBy = [...new Set([...(prev.reportedBy ?? [prev.dimension]), ...(f.reportedBy ?? [f.dimension])])];
    prev.corroboratingProbes = [...(prev.corroboratingProbes ?? []), { dimension: f.dimension, probe: f.probe, observed: f.observed }];
    if ((rank[f.severity] ?? 0) > (rank[prev.severity] ?? 0)) prev.severity = f.severity;
    prev.confidence = Math.max(prev.confidence, f.confidence);
  }
  return out;
}

/**
 * Name the seeded defect behind a confirmed finding by re-running its probe with
 * exactly one defect active at a time. Automatic, oracle-backed attribution —
 * no model in the loop, so the recall number cannot be talked up.
 */
export async function attribute(finding, { target, browser, bugIds }) {
  const setBugs = async (bugs) => {
    await fetch(`${target.baseUrl}/api/test/bugs`, {
      method: 'POST',
      headers: { 'x-seed-token': target.seedToken, 'content-type': 'application/json' },
      body: JSON.stringify({ bugs }),
    });
  };
  try {
    for (const id of bugIds) {
      await setBugs([id]);
      const r = await replay(finding.probe, target, browser, null);
      if (r.held === true) return id;
    }
    return null;
  } finally {
    await setBugs(bugIds);   // restore the full target build
  }
}
