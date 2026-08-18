// App lifecycle + the authentication wedge.
//
// The demo-app-to-real-app gap is mostly this file. An evaluation agent cannot
// reason about an app it cannot get into, and every finding is worthless if it
// cannot be replayed from a known state. So the harness owns two contracts:
//
//   1. Seeding   — reset the app to a deterministic fixture before every run
//                  and before every reproduction attempt.
//   2. Auth      — complete a real multi-step login, including the emailed OTP,
//                  once per role, then hand out reusable browser storage state
//                  so agents never spend turns (or flake) on the login form.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../..');

export class AppHarness {
  constructor({ port, bugs = 'all', seedToken = 'dev-seed-token', label = 'target' }) {
    this.port = port;
    this.bugs = bugs;
    this.seedToken = seedToken;
    this.label = label;
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.proc = null;
    this.seedData = null;
  }

  async start() {
    this.proc = spawn(process.execPath, [path.join(REPO_ROOT, 'ledgerly/server.js')], {
      env: { ...process.env, PORT: String(this.port), LEDGERLY_BUGS: this.bugs, SEED_TOKEN: this.seedToken },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', () => {});
    this.proc.stderr.on('data', (d) => process.stderr.write(`[${this.label}] ${d}`));
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${this.baseUrl}/api/test/health`);
        if (r.ok) return this;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`${this.label} app did not become healthy on :${this.port}`);
  }

  async stop() {
    if (!this.proc) return;
    this.proc.kill('SIGTERM');
    this.proc = null;
  }

  /** Reset to a deterministic fixture. Returns credentials + probe fixtures. */
  async seed(scenario = 'default') {
    const r = await fetch(`${this.baseUrl}/api/test/seed`, {
      method: 'POST',
      headers: { 'x-seed-token': this.seedToken, 'content-type': 'application/json' },
      body: JSON.stringify({ scenario }),
    });
    if (!r.ok) throw new Error(`seed failed: ${r.status}`);
    this.seedData = await r.json();
    return this.seedData;
  }

  /**
   * The OTP wedge. Reads the code out of the app's test mailbox rather than
   * guessing at it or asking a human. Polls, because the mail write and the
   * login response race in most real apps.
   */
  async fetchOtp(email, { notBefore = 0, timeoutMs = 8000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await fetch(`${this.baseUrl}/api/test/mailbox?email=${encodeURIComponent(email)}`,
        { headers: { 'x-seed-token': this.seedToken } });
      if (r.ok) {
        const { messages } = await r.json();
        const hit = messages.find((m) => m.sentAt >= notBefore && /\b\d{6}\b/.test(m.body));
        if (hit) return hit.body.match(/\b(\d{6})\b/)[1];
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    throw new Error(`no OTP arrived for ${email} within ${timeoutMs}ms`);
  }

  credentials(role = 'primary') {
    if (!this.seedData) throw new Error('seed() must run before credentials()');
    const u = this.seedData.users[role];
    if (!u) throw new Error(`unknown role: ${role}`);
    return u;
  }

  /** Full login over HTTP (used for API probes and to mint browser cookies). */
  async loginApi(role = 'primary') {
    const { email, password } = this.credentials(role);
    const t0 = Date.now();
    const chRes = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!chRes.ok) throw new Error(`login rejected for ${email}: ${chRes.status}`);
    const ch = await chRes.json();
    if (!ch.otpRequired) throw new Error('expected an OTP challenge');
    const code = await this.fetchOtp(email, { notBefore: t0 });
    const vRes = await fetch(`${this.baseUrl}/api/auth/verify-otp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: ch.challengeId, code }),
    });
    if (!vRes.ok) throw new Error(`OTP verification failed: ${vRes.status}`);
    const cookie = (vRes.headers.get('set-cookie') || '').split(';')[0];
    if (!cookie.startsWith('sid=')) throw new Error('no session cookie issued');
    return { cookie, sid: cookie.slice(4), email, challengeId: ch.challengeId };
  }

  /**
   * Playwright storage state for a role — the artifact agents actually consume.
   * Authenticating once and replaying the cookie keeps 2FA out of every agent's
   * turn budget and removes the single largest source of run-to-run flake.
   */
  async storageState(role = 'primary') {
    const { sid } = await this.loginApi(role);
    return {
      cookies: [{
        name: 'sid', value: sid, domain: '127.0.0.1', path: '/',
        expires: Math.floor(Date.now() / 1000) + 3600,
        httpOnly: true, secure: false, sameSite: 'Lax',
      }],
      origins: [],
    };
  }
}
