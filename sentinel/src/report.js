// The deliverable: one markdown file. No dashboard, no auth, no billing.
// Optimised for a reviewer deciding, in about thirty seconds per finding,
// whether the app broke or the agent was wrong.
import { SUPPRESSED, VERDICTS } from './verify.js';
import { GROUND_TRUTH } from '../../ledgerly/bugs.js';

const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const BADGE = {
  [VERDICTS.CONFIRMED]: '✅ CONFIRMED',
  [VERDICTS.FLAKY]: '⚠️ INTERMITTENT',
  [VERDICTS.NOT_REPRODUCED]: '🚫 not reproduced',
  [VERDICTS.CONTROL_ALSO_FIRES]: '🚫 fires on control build',
  [VERDICTS.UNVERIFIABLE]: '🚫 probe could not run',
};

const fmt = (v) => (v === null || v === undefined ? '—' : typeof v === 'object' ? `\`${JSON.stringify(v)}\`` : `\`${v}\``);

function stepsToMarkdown(probe) {
  return (probe?.steps ?? []).map((s, i) => {
    const n = `${i + 1}.`;
    switch (s.op) {
      case 'seed': return `${n} Reset the app to the \`${s.scenario || 'default'}\` fixture`;
      case 'login': return `${n} Sign in as **${s.as || 'primary'}** (password + emailed OTP)`;
      case 'goto': return `${n} Open \`${s.path}\``;
      case 'setViewport': return `${n} Resize viewport to ${s.width}×${s.height}`;
      case 'click': return `${n} Click ${s.selector ? `\`${s.selector}\`` : `"${s.text}"`}`;
      case 'fill': return `${n} Type \`${s.value}\` into \`${s.selector}\``;
      case 'press': return `${n} Press ${s.key} in \`${s.selector}\``;
      case 'wait': return `${n} Wait ${s.ms}ms`;
      case 'api': return `${n} \`${s.method || 'GET'} ${s.path}\` as **${s.as ?? 'anonymous'}**`;
      default: return `${n} ${JSON.stringify(s)}`;
    }
  }).join('\n');
}

function assertionToEnglish(a = {}) {
  const cmp = 'equals' in a ? `is ${fmt(a.equals)}`
    : 'notEquals' in a ? `is not ${fmt(a.notEquals)}`
    : 'greaterThan' in a ? `is greater than ${fmt(a.greaterThan)}`
    : 'lessThan' in a ? `is less than ${fmt(a.lessThan)}`
    : 'matches' in a ? `matches /${a.matches}/i` : '';
  switch (a.kind) {
    case 'httpStatus': return `the response status ${cmp}`;
    case 'responseTimeMs': return `the response time in ms ${cmp}`;
    case 'jsonNumber': case 'jsonEquals': return `\`${a.path}\` in the response body ${cmp}`;
    case 'elementCount': return `the number of \`${a.selector}\` elements ${cmp}`;
    case 'textPresent': return `the text "${a.text}" is present`;
    case 'textAbsent': return `the text "${a.text}" is absent`;
    case 'consoleError': return `a console error ${cmp}`;
    case 'overflowsViewport': return `\`${a.selector}\` extends past the viewport edge`;
    case 'missingAccessibleName': return `\`${a.selector}\` has no programmatic accessible name`;
    default: return JSON.stringify(a);
  }
}

function evidenceLinks(f) {
  const e = f.evidence ?? {};
  const out = [];
  if (e.lastScreenshot) out.push(`[screenshot at failure](${e.lastScreenshot})`);
  if (e.steps) out.push(`[step trace](${e.steps})`);
  if (e.trace) out.push(`[Playwright trace](${e.trace})`);
  const ae = f.agentEvidence ?? {};
  if (ae.video) out.push(`[agent session video](${ae.video})`);
  if (ae.lastScreenshot && ae.lastScreenshot !== e.lastScreenshot) out.push(`[agent screenshot](${ae.lastScreenshot})`);
  return out.length ? out.join(' · ') : '_none captured_';
}

function findingSection(f, i) {
  const gt = f.attributedBug ? GROUND_TRUTH[f.attributedBug] : null;
  return `
### ${i}. ${f.title}

**${BADGE[f.verdict]}** · severity **${f.severity}** · confidence **${(f.confidence * 100).toFixed(0)}%** · dimension \`${f.dimension}\`${f.reportedBy?.length > 1 ? ` · independently reported by ${f.reportedBy.length} agents` : ''}

${f.summary}

| | |
|---|---|
| **Expected** | ${f.expected} |
| **Actual** | ${f.actual} |
| **Impact** | ${f.userImpact} |
| **Reproduced** | ${f.reproCount}/${f.reproAttempts} independent replays, each from a fresh seed |
| **Control build** | ${f.controlFired === false ? 'assertion did **not** fire — behaviour is specific to this build' : f.controlFired === true ? '⚠️ also fired' : 'not run'} |
| **Observed value** | ${fmt(f.observed)} |
${gt ? `| **Root defect** | \`${f.attributedBug}\` — ${gt.title} (${gt.where}) |\n` : ''}
**Steps to reproduce**

${stepsToMarkdown(f.probe)}

**Automated check** — this finding is recorded as present when ${assertionToEnglish(f.probe?.assert)}.

${f.consoleErrors?.length ? `**Console during replay**\n\n\`\`\`\n${f.consoleErrors.join('\n')}\n\`\`\`\n` : ''}
**Evidence** — ${evidenceLinks(f)}

<sub>Agent self-reported confidence was ${(Number(f.agentConfidence ?? 0) * 100).toFixed(0)}%; the confidence above is computed from replay outcomes, not from the agent.</sub>
`;
}

const FRICTION_ORDER = { major: 0, moderate: 1, minor: 2, praise: 3 };
const FRICTION_LABEL = { major: '🔴 major', moderate: '🟠 moderate', minor: '🟡 minor', praise: '🟢 praise' };

function experienceSection(agents) {
  const notes = agents.flatMap((a) => a.experienceNotes ?? []);
  const ratings = agents.flatMap((a) => a.journeyRatings ?? []);
  const L = [];
  L.push(`## Experience review`);
  L.push('');
  L.push('Judgement, not defects. Nothing in this section is probe-verified, it is kept out of the defect count and out of the false-positive rate, and it is what the agents thought of actually using the product. Read it as a review, not as a bug list.');
  L.push('');

  if (ratings.length) {
    const byJourney = new Map();
    for (const r of ratings) {
      const key = String(r.journey || 'general').trim();
      if (!byJourney.has(key)) byJourney.set(key, []);
      byJourney.get(key).push(r);
    }
    L.push(`### Journey scorecard`);
    L.push('');
    L.push(`| Journey | Score | Rated by | What the agents said |`);
    L.push(`|---|---|---|---|`);
    for (const [journey, rs] of [...byJourney.entries()].sort((a, b) => {
      const avg = (x) => x[1].reduce((s, r) => s + Number(r.rating || 0), 0) / x[1].length;
      return avg(a) - avg(b);
    })) {
      const avg = rs.reduce((s, r) => s + Number(r.rating || 0), 0) / rs.length;
      const stars = '★'.repeat(Math.round(avg)) + '☆'.repeat(5 - Math.round(avg));
      L.push(`| ${journey.replace(/\|/g, '\\|')} | ${stars} ${avg.toFixed(1)} | ${rs.length} agent(s) | ${rs.map((r) => r.reason).join(' · ').replace(/\|/g, '\\|').slice(0, 220)} |`);
    }
    L.push('');
  }

  if (!notes.length) {
    L.push('_No experience notes recorded this run._');
    L.push('');
    return L;
  }
  notes.sort((a, b) => (FRICTION_ORDER[a.friction] ?? 9) - (FRICTION_ORDER[b.friction] ?? 9));
  const actionable = notes.filter((n) => n.friction !== 'praise');
  if (actionable.length) {
    L.push(`### Recommendations, worst friction first`);
    L.push('');
    for (const n of actionable) {
      L.push(`**${FRICTION_LABEL[n.friction] ?? n.friction} · ${n.journey}** <sub>— \`${n.dimension}\`</sub>`);
      L.push('');
      L.push(`${n.observation}`);
      L.push('');
      L.push(`> **Suggested change.** ${n.suggestion}`);
      L.push('');
    }
  }
  const praise = notes.filter((n) => n.friction === 'praise');
  if (praise.length) {
    L.push(`### Working well — do not regress`);
    L.push('');
    for (const n of praise) L.push(`- **${n.journey}** — ${n.observation}`);
    L.push('');
  }
  return L;
}

export function buildReport({ runId, target, control, agents, verified, scoring, startedAt, durationMs, activeBugs }) {
  const published = verified.filter((f) => !SUPPRESSED.has(f.verdict))
    .sort((a, b) => (SEV_ORDER[a.severity] - SEV_ORDER[b.severity]) || (b.confidence - a.confidence));
  const suppressed = verified.filter((f) => SUPPRESSED.has(f.verdict));
  const totalCost = agents.reduce((s, a) => s + (a.costUsd || 0), 0);

  const L = [];
  L.push(`# Ledgerly — automated evaluation report`);
  L.push('');
  L.push(`**Run** \`${runId}\` · started ${new Date(startedAt).toISOString()} · wall clock ${(durationMs / 1000).toFixed(0)}s · agent spend $${totalCost.toFixed(2)}`);
  L.push('');
  L.push(`Target build \`${target}\`. Findings were replayed against control build \`${control}\` before publication.`);
  L.push('');

  L.push(`## Summary`);
  L.push('');
  L.push(`| | |`);
  L.push(`|---|---|`);
  L.push(`| Defects published | **${scoring.counts.published}** (${scoring.counts.confirmed} confirmed, ${scoring.counts.flaky} intermittent) |`);
  L.push(`| Claims suppressed before publication | ${scoring.counts.suppressed} |`);
  if (scoring.attributionRan) {
    L.push(`| **False-positive rate (published)** | **${scoring.falsePositiveRatePct}%** |`);
    L.push(`| False-positive rate without the verification layer | ${scoring.unsuppressedFalsePositiveRatePct}% |`);
    L.push(`| Seeded defects detected | ${scoring.recall.found}/${scoring.recall.activeDefects} (${scoring.recall.recallPct}%) |`);
  } else {
    L.push(`| False-positive rate | _not measured — attribution oracle disabled for this run_ |`);
  }
  const expNotes = agents.flatMap((a) => a.experienceNotes ?? []);
  L.push(`| Experience notes (unverified judgement) | ${expNotes.length}, of which ${expNotes.filter((n) => n.friction === 'major' || n.friction === 'moderate').length} moderate or worse |`);
  L.push('');

  if (published.length) {
    L.push(`## Findings`);
    published.forEach((f, i) => L.push(findingSection(f, i + 1)));
  } else {
    L.push(`## Findings`);
    L.push('');
    L.push('_No defect survived verification in this run._');
    L.push('');
  }

  L.push(...experienceSection(agents));

  L.push(`## Claims that did not survive verification`);
  L.push('');
  L.push('Every agent claim is replayed twice from a fresh seed and once against a known-good control build. These did not hold up and were kept out of the findings above. They are listed so the suppression is auditable rather than invisible.');
  L.push('');
  if (suppressed.length) {
    L.push(`| Claim | Dimension | Reason withheld | Replays |`);
    L.push(`|---|---|---|---|`);
    for (const f of suppressed) {
      const why = f.verdict === VERDICTS.CONTROL_ALSO_FIRES
        ? 'the same assertion also fires on the known-good build, so it describes intended behaviour or harness noise'
        : f.verdict === VERDICTS.NOT_REPRODUCED ? 'did not reproduce on replay'
        : `probe could not execute (${(f.replayErrors ?? [])[0] ?? 'unknown'})`;
      L.push(`| ${f.title.replace(/\|/g, '\\|')} | \`${f.dimension}\` | ${why} | ${f.reproCount}/${f.reproAttempts} |`);
    }
  } else {
    L.push('_None — every claim reproduced._');
  }
  L.push('');

  L.push(`## What was exercised and found working`);
  L.push('');
  L.push('Silence is ambiguous, so each agent reports what it deliberately checked and found healthy.');
  L.push('');
  for (const a of agents) {
    L.push(`**${a.title}** (\`${a.model}\`)`);
    L.push('');
    if (a.checkedButHealthy?.length) a.checkedButHealthy.forEach((c) => L.push(`- ${c}`));
    else L.push(`- _nothing recorded${a.error ? ` — agent ended with: ${a.error}` : ''}_`);
    L.push('');
  }

  L.push(`## Agent roster`);
  L.push('');
  L.push(`| Dimension | Model | Turns | Tool calls | Defect claims | Experience notes | Duration | Cost |`);
  L.push(`|---|---|---|---|---|---|---|---|`);
  for (const a of agents) {
    L.push(`| ${a.title} | \`${a.model}\` | ${a.turns} | ${a.toolCalls} | ${a.findings.length} | ${(a.experienceNotes ?? []).length} | ${(a.durationMs / 1000).toFixed(0)}s | $${(a.costUsd || 0).toFixed(2)} |`);
  }
  L.push('');

  L.push(`## Measurement appendix`);
  L.push('');
  L.push('The false-positive rate above is not self-assessed. Each published finding is replayed with exactly one seeded defect enabled at a time; a finding is counted as a true positive only when that oracle names the defect behind it. A published finding no defect explains is counted as a false positive even when it looks plausible.');
  L.push('');
  L.push('```json');
  L.push(JSON.stringify(scoring, null, 2));
  L.push('```');
  L.push('');
  if (scoring.recall.missedIds.length) {
    L.push(`### Seeded defects this run did not surface`);
    L.push('');
    for (const id of scoring.recall.missedIds) {
      const gt = GROUND_TRUTH[id];
      L.push(`- \`${id}\` — ${gt.title} _(expected owner: \`${gt.dimension}\`)_`);
    }
    L.push('');
  }
  L.push(`<sub>Active seeded defects in the target build: ${activeBugs.join(', ') || 'none'}.</sub>`);
  L.push('');
  return L.join('\n');
}
