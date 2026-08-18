#!/usr/bin/env node
// Sentinel — orchestrator.
//
//   1. boot the target build and a known-good control build
//   2. authenticate once per role (password + emailed OTP) and cache session state
//   3. fan out five dimension subagents, each with its own model and browser
//   4. dedupe their claims, then verify each by deterministic replay
//   5. attribute survivors to a specific defect, score, and write the report
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { AppHarness, REPO_ROOT } from './src/harness.js';
import { RunEvidence } from './src/evidence.js';
import { DIMENSIONS } from './src/dimensions.js';
import { runDimensionAgent } from './src/agent-runner.js';
import { dedupe, verifyFinding, attribute, mergeByAttribution, SUPPRESSED } from './src/verify.js';
import { score } from './src/scoring.js';
import { buildReport } from './src/report.js';
import { BUG_IDS, HONEYPOTS } from '../ledgerly/bugs.js';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const has = (name) => argv.includes(`--${name}`);

const CONFIG = {
  bugs: flag('bugs', 'all'),                    // target build defect set
  only: flag('only', '')                        // comma-separated dimension keys
    .split(',').map((s) => s.trim()).filter(Boolean),
  model: flag('model', ''),                     // override every agent's model
  targetPort: Number(flag('target-port', 4410)),
  controlPort: Number(flag('control-port', 4411)),
  headed: has('headed'),
  noAttribute: has('no-attribute'),
  concurrency: Number(flag('concurrency', 5)),
};

const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
const log = (...a) => console.log(`[sentinel]`, ...a);

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

async function main() {
  const startedAt = Date.now();
  const evidence = new RunEvidence(path.join(REPO_ROOT, 'runs'), runId);
  log(`run ${runId}`);
  log(`evidence → ${path.relative(process.cwd(), evidence.root)}`);

  const target = new AppHarness({ port: CONFIG.targetPort, bugs: CONFIG.bugs, label: 'target' });
  const control = new AppHarness({ port: CONFIG.controlPort, bugs: 'none', label: 'control' });
  await Promise.all([target.start(), control.start()]);
  const seedInfo = await target.seed('default');
  await control.seed('default');
  const activeBugs = seedInfo.activeBugs;
  log(`target build defects: ${activeBugs.join(', ') || 'none'}`);

  // Prove the auth wedge works before spending a single agent turn on it.
  const auth = await target.loginApi('primary');
  log(`authenticated ${auth.email} via password + emailed OTP`);

  const browser = await chromium.launch({ headless: !CONFIG.headed });
  const dims = CONFIG.only.length ? DIMENSIONS.filter((d) => CONFIG.only.includes(d.key)) : DIMENSIONS;
  log(`dispatching ${dims.length} agents: ${dims.map((d) => `${d.key}(${CONFIG.model || d.model})`).join(', ')}`);

  const agents = await pool(dims, CONFIG.concurrency, async (dim) => {
    const t0 = Date.now();
    const res = await runDimensionAgent(dim, {
      target, browser, evidence, modelOverride: CONFIG.model || undefined,
      onEvent: () => {},
    });
    log(`  ${dim.key}: ${res.findings.length} claim(s), ${res.toolCalls} tool calls, ${((Date.now() - t0) / 1000).toFixed(0)}s${res.error ? `, error: ${res.error}` : ''}`);
    return res;
  });
  evidence.writeJson('agents.json', agents);

  const raw = agents.flatMap((a) => a.findings);
  const deduped = dedupe(raw);
  log(`${raw.length} raw claim(s) → ${deduped.length} after dedupe; verifying…`);

  // Verification is serial on purpose: replays share the target app's fixture
  // state, and a seed from one replay would corrupt another running in parallel.
  const verified = [];
  for (const [i, f] of deduped.entries()) {
    const v = await verifyFinding(f, { target, control, browser, evidence, index: i + 1 });
    if (!SUPPRESSED.has(v.verdict) && !CONFIG.noAttribute) {
      v.attributedBug = await attribute(v, { target, browser, bugIds: activeBugs });
    } else {
      v.attributedBug = null;
    }
    log(`  [${v.verdict}] ${v.title.slice(0, 72)}${v.attributedBug ? ` → ${v.attributedBug}` : ''}`);
    verified.push(v);
  }

  const merged = CONFIG.noAttribute ? verified : mergeByAttribution(verified);
  if (merged.length !== verified.length) {
    log(`${verified.length - merged.length} finding(s) merged as duplicates of the same defect`);
  }
  const scoring = score({ raw, deduped, verified: merged, activeBugs, honeypots: HONEYPOTS, attributed: !CONFIG.noAttribute });
  const durationMs = Date.now() - startedAt;

  const markdown = buildReport({
    runId, target: CONFIG.bugs, control: 'none',
    agents, verified: merged, scoring, startedAt, durationMs, activeBugs,
  });
  const reportPath = path.join(evidence.root, 'report.md');
  fs.writeFileSync(reportPath, markdown);
  evidence.writeJson('findings.json', merged);
  evidence.writeJson('scoring.json', scoring);

  await browser.close();
  await Promise.all([target.stop(), control.stop()]);

  log('');
  log(`published ${scoring.counts.published} finding(s), suppressed ${scoring.counts.suppressed}`);
  if (scoring.attributionRan) {
    log(`false-positive rate: ${scoring.falsePositiveRatePct}%  (without verification: ${scoring.unsuppressedFalsePositiveRatePct}%)`);
    log(`recall: ${scoring.recall.found}/${scoring.recall.activeDefects} seeded defects (${scoring.recall.recallPct}%)`);
  } else {
    log('false-positive rate: not measured (--no-attribute)');
  }
  log(`report → ${path.relative(process.cwd(), reportPath)}`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
