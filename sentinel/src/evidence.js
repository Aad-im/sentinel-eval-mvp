// Evidence layer.
//
// Built before the agents, not after. When a report says "failed", a reviewer
// must be able to decide in ~30 seconds whether the app broke or the agent was
// wrong. That requires, for every finding: the exact steps, a screenshot at the
// point of failure, the console and network traffic, a Playwright trace, and a
// video — all addressable by relative path from the report.
import fs from 'node:fs';
import path from 'node:path';

export class RunEvidence {
  constructor(rootDir, runId) {
    this.runId = runId;
    this.root = path.join(rootDir, runId);
    fs.mkdirSync(this.root, { recursive: true });
  }
  dir(...parts) {
    const p = path.join(this.root, ...parts);
    fs.mkdirSync(p, { recursive: true });
    return p;
  }
  writeJson(rel, data) {
    const p = path.join(this.root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
    return path.relative(this.root, p);
  }
  writeText(rel, text) {
    const p = path.join(this.root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    return path.relative(this.root, p);
  }
  recorder(scope, { trace = true, video = true } = {}) {
    return new Recorder(this, scope, { trace, video });
  }
}

export class Recorder {
  constructor(run, scope, { trace, video }) {
    this.run = run;
    this.scope = scope;
    this.base = run.dir('evidence', scope);
    this.shotsDir = path.join(this.base, 'screenshots');
    this.videoDir = video ? path.join(this.base, 'video') : null;
    fs.mkdirSync(this.shotsDir, { recursive: true });
    if (this.videoDir) fs.mkdirSync(this.videoDir, { recursive: true });
    this.traceEnabled = trace;
    this.stepsPath = path.join(this.base, 'steps.jsonl');
    this.shots = [];
    this._n = 0;
  }
  step(entry) {
    fs.appendFileSync(this.stepsPath, JSON.stringify(entry) + '\n');
  }
  tracePath() {
    return path.join(this.base, 'trace.zip');
  }
  /** Screenshot on every meaningful action — cheap, and the thing reviewers open first. */
  async shot(page, label) {
    if (!page) return null;
    const name = `${String(++this._n).padStart(3, '0')}-${String(label).replace(/[^a-z0-9-]/gi, '_')}.png`;
    const abs = path.join(this.shotsDir, name);
    try {
      await page.screenshot({ path: abs, fullPage: false });
    } catch { return null; }
    const rel = path.relative(this.run.root, abs);
    this.shots.push(rel);
    return rel;
  }
  manifest() {
    const rel = (p) => (p && fs.existsSync(p) ? path.relative(this.run.root, p) : null);
    let video = null;
    if (this.videoDir && fs.existsSync(this.videoDir)) {
      const f = fs.readdirSync(this.videoDir).find((x) => x.endsWith('.webm'));
      if (f) video = path.relative(this.run.root, path.join(this.videoDir, f));
    }
    return {
      scope: this.scope,
      screenshots: this.shots,
      lastScreenshot: this.shots.at(-1) ?? null,
      steps: rel(this.stepsPath),
      trace: rel(this.tracePath()),
      video,
    };
  }
}
