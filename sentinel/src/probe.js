// A small, deterministic probe language.
//
// Agents do not get to say "the total looked wrong". They must emit a probe:
// a replayable sequence of steps plus one machine-checkable assertion that is
// TRUE when the defect is present. The verifier replays that probe from a fresh
// seed, on a fresh browser context, against both the target build and a control
// build. Everything downstream — confidence, suppression, the false-positive
// rate — is derived from those replays rather than from the agent's opinion.
export const PROBE_OPS = ['seed', 'login', 'goto', 'setViewport', 'click', 'fill', 'selectOption', 'pressKey',
  'goBack', 'waitForText', 'wait', 'api', 'startLogin', 'submitOtp'];
export const ASSERTION_KINDS = [
  'httpStatus', 'jsonNumber', 'jsonEquals', 'responseTimeMs',
  'elementCount', 'textPresent', 'textAbsent', 'consoleError',
  'overflowsViewport', 'missingAccessibleName',
];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

function readPath(obj, dotted) {
  return String(dotted || '').split('.').filter(Boolean).reduce((acc, key) => {
    if (acc == null) return undefined;
    const idx = Number(key);
    return Number.isInteger(idx) && Array.isArray(acc) ? acc[idx] : acc[key];
  }, obj);
}

function compare(actual, cmp) {
  if ('equals' in cmp) return actual === cmp.equals;
  if ('notEquals' in cmp) return actual !== cmp.notEquals;
  if ('greaterThan' in cmp) return num(actual) > cmp.greaterThan;
  if ('lessThan' in cmp) return num(actual) < cmp.lessThan;
  if ('matches' in cmp) return new RegExp(cmp.matches, 'i').test(String(actual ?? ''));
  throw new Error('assertion needs one of: equals, notEquals, greaterThan, lessThan, matches');
}

/**
 * Execute a probe. Returns { held, observed, steps, console, requests }.
 * `held === true` means the asserted defect was observed.
 */
export async function runProbe(probe, ctx) {
  const { harness, browser, recorder } = ctx;
  const steps = [];
  const consoleErrors = [];
  const dialogs = [];
  const requests = [];
  let lastResponse = null;   // { status, body, ms }
  let page = null;
  let context = null;
  const roleCookies = {};
  let challenge = null;   // live OTP challenge, carried between steps

  const log = (op, detail) => {
    const entry = { n: steps.length + 1, op, ...detail, at: new Date().toISOString() };
    steps.push(entry);
    recorder?.step(entry);
    return entry;
  };

  const ensurePage = async (role = 'primary') => {
    if (page) return page;
    const storageState = await harness.storageState(role);
    context = await browser.newContext({
      storageState,
      viewport: { width: 1280, height: 800 },
      recordVideo: recorder?.videoDir ? { dir: recorder.videoDir, size: { width: 1280, height: 800 } } : undefined,
    });
    if (recorder?.traceEnabled) await context.tracing.start({ screenshots: true, snapshots: true });
    page = await context.newPage();
    page.on('dialog', async (d) => {
      dialogs.push({ type: d.type(), message: d.message(), accepted: true });
      try { await d.accept(); } catch { /* already handled */ }
    });
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e?.message ?? e)));
    page.on('response', (r) => requests.push({ url: r.url(), status: r.status() }));
    return page;
  };

  const cookieFor = async (role) => (roleCookies[role] ??= (await harness.loginApi(role)).cookie);

  try {
    for (const raw of probe.steps ?? []) {
      const step = raw || {};
      switch (step.op) {
        case 'seed': {
          await harness.seed(step.scenario || 'default');
          log('seed', { scenario: step.scenario || 'default' });
          break;
        }
        case 'login': {
          const role = step.as || 'primary';
          await cookieFor(role);
          if (page) { await context.close(); page = null; context = null; }
          await ensurePage(role);
          log('login', { as: role });
          break;
        }
        case 'goto': {
          const p = await ensurePage(step.as || 'primary');
          await p.goto(`${harness.baseUrl}${step.path || '/'}`, { waitUntil: 'networkidle', timeout: 20_000 });
          log('goto', { path: step.path });
          await recorder?.shot(p, `goto${steps.length}`);
          break;
        }
        case 'setViewport': {
          const p = await ensurePage();
          await p.setViewportSize({ width: step.width || 1280, height: step.height || 800 });
          log('setViewport', { width: step.width, height: step.height });
          break;
        }
        case 'click': {
          const p = await ensurePage();
          const loc = step.selector ? p.locator(step.selector).first() : p.getByText(step.text, { exact: false }).first();
          await loc.click({ timeout: 10_000 });
          log('click', { selector: step.selector, text: step.text });
          await p.waitForTimeout(step.settleMs ?? 250);
          await recorder?.shot(p, `click${steps.length}`);
          break;
        }
        case 'fill': {
          const p = await ensurePage();
          await p.locator(step.selector).first().fill(String(step.value ?? ''), { timeout: 10_000 });
          log('fill', { selector: step.selector, value: step.value });
          break;
        }
        case 'press': {
          const p = await ensurePage();
          await p.locator(step.selector).first().press(step.key || 'Enter');
          log('press', { selector: step.selector, key: step.key });
          break;
        }
        case 'wait': {
          const ms = Math.min(Number(step.ms) || 250, 5000);
          await new Promise((r) => setTimeout(r, ms));
          log('wait', { ms });
          break;
        }
        case 'selectOption': {
          const p = await ensurePage();
          const loc = p.locator(step.selector).first();
          await loc.selectOption(step.value !== undefined ? { value: String(step.value) } : { label: String(step.label) }, { timeout: 10_000 });
          log('selectOption', { selector: step.selector, value: step.value, label: step.label });
          await p.waitForTimeout(step.settleMs ?? 250);
          break;
        }
        case 'pressKey': {
          const p = await ensurePage();
          if (step.selector) await p.locator(step.selector).first().press(step.key || 'Enter');
          else await p.keyboard.press(step.key || 'Tab');
          log('pressKey', { selector: step.selector, key: step.key });
          await p.waitForTimeout(step.settleMs ?? 150);
          break;
        }
        case 'goBack': {
          const p = await ensurePage();
          await p.goBack({ waitUntil: 'networkidle', timeout: 15_000 });
          log('goBack', {});
          break;
        }
        case 'waitForText': {
          const p = await ensurePage();
          try {
            await p.getByText(step.text, { exact: false }).first().waitFor({ timeout: step.timeoutMs ?? 8000 });
            log('waitForText', { text: step.text, found: true });
          } catch { log('waitForText', { text: step.text, found: false }); }
          break;
        }
        // Native OTP handling. Without these an agent has to hardcode a
        // challenge id that is already dead by replay time, which makes every
        // genuine 2FA defect look like it failed to reproduce.
        case 'startLogin': {
          const role = step.as || 'primary';
          const { email, password } = harness.credentials(role);
          const t0 = performance.now();
          const wall = Date.now();
          const r = await fetch(`${harness.baseUrl}/api/auth/login`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email, password: step.password ?? password }),
          });
          const body = await r.json().catch(() => null);
          lastResponse = { status: r.status, body, ms: Math.round(performance.now() - t0) };
          challenge = body?.challengeId
            ? { id: body.challengeId, email, issuedAt: wall }
            : null;
          log('startLogin', { as: role, status: r.status, gotChallenge: !!challenge });
          break;
        }
        case 'submitOtp': {
          if (!challenge) throw new Error('submitOtp requires a preceding startLogin that issued a challenge');
          const times = Math.min(Math.max(1, Number(step.times) || 1), 25);
          const useReal = step.code === 'correct';
          const realCode = useReal ? await harness.fetchOtp(challenge.email, { notBefore: challenge.issuedAt }) : null;
          for (let i = 0; i < times; i++) {
            const code = useReal ? realCode : String(step.code ?? '000000');
            const t0 = performance.now();
            const r = await fetch(`${harness.baseUrl}/api/auth/verify-otp`, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ challengeId: challenge.id, code }),
            });
            const body = await r.json().catch(() => null);
            lastResponse = { status: r.status, body, ms: Math.round(performance.now() - t0) };
          }
          log('submitOtp', { times, code: useReal ? '<correct>' : step.code, finalStatus: lastResponse.status });
          break;
        }
        case 'api': {
          const headers = { 'content-type': 'application/json' };
          if (step.as && step.as !== 'none') headers.cookie = await cookieFor(step.as);
          const t0 = performance.now();
          const res = await fetch(`${harness.baseUrl}${step.path}`, {
            method: step.method || 'GET', headers,
            body: step.body === undefined ? undefined : JSON.stringify(step.body),
          });
          let body = null;
          try { body = await res.json(); } catch { body = null; }
          lastResponse = { status: res.status, body, ms: Math.round(performance.now() - t0) };
          log('api', { method: step.method || 'GET', path: step.path, as: step.as ?? 'none', status: res.status, ms: lastResponse.ms });
          break;
        }
        default:
          throw new Error(`unknown probe op: ${step.op}`);
      }
    }

    const a = probe.assert || {};
    let observed;
    let held;

    switch (a.kind) {
      case 'httpStatus':
        if (!lastResponse) throw new Error('httpStatus assertion requires a prior api, startLogin or submitOtp step');
        observed = lastResponse.status;
        held = compare(observed, a);
        break;
      case 'responseTimeMs':
        if (!lastResponse) throw new Error('responseTimeMs assertion requires a prior api, startLogin or submitOtp step');
        observed = lastResponse.ms;
        held = compare(observed, a);
        break;
      case 'jsonNumber':
      case 'jsonEquals':
        if (!lastResponse) throw new Error('json assertion requires a prior api, startLogin or submitOtp step');
        observed = readPath(lastResponse.body, a.path);
        held = compare(observed, a);
        break;
      case 'elementCount': {
        const p = await ensurePage();
        observed = await p.locator(a.selector).count();
        held = compare(observed, a);
        break;
      }
      case 'textPresent':
      case 'textAbsent': {
        const p = await ensurePage();
        const n = await p.getByText(a.text, { exact: false }).count();
        observed = n;
        held = a.kind === 'textPresent' ? n > 0 : n === 0;
        break;
      }
      case 'consoleError':
        observed = consoleErrors.slice(0, 8);
        held = consoleErrors.some((e) => new RegExp(a.matches || '.', 'i').test(e));
        break;
      case 'overflowsViewport': {
        const p = await ensurePage();
        const loc = p.locator(a.selector).first();
        if (!(await loc.count())) { observed = { missing: true, selector: a.selector }; held = false; break; }
        observed = await loc.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return {
            elementRight: Math.round(r.right), elementWidth: Math.round(r.width),
            viewportWidth: window.innerWidth,
            overflowPx: Math.round(Math.max(0, r.right - window.innerWidth, -r.left)),
          };
        });
        held = observed.overflowPx > 2;
        break;
      }
      case 'missingAccessibleName': {
        const p = await ensurePage();
        const loc = p.locator(a.selector).first();
        if (!(await loc.count())) { observed = { missing: true, selector: a.selector }; held = false; break; }
        observed = await loc.evaluate((el) => {
          const id = el.getAttribute('id');
          const hasLabelFor = id ? !!document.querySelector(`label[for="${CSS.escape(id)}"]`) : false;
          const wrapped = !!el.closest('label');
          const aria = el.getAttribute('aria-label');
          const labelledBy = el.getAttribute('aria-labelledby');
          const title = el.getAttribute('title');
          const NAME_FROM_CONTENT = ['button', 'a', 'summary', 'th', 'td', 'label', 'legend'];
          const role = el.getAttribute('role');
          const namesFromContent = NAME_FROM_CONTENT.includes(el.tagName.toLowerCase())
            || ['button', 'link', 'tab', 'menuitem', 'heading'].includes(role);
          const contentName = namesFromContent ? (el.innerText || '').trim() : '';
          return {
            id, hasLabelFor, wrappedInLabel: wrapped,
            ariaLabel: aria, ariaLabelledby: labelledBy, title,
            namesFromOwnContent: namesFromContent, contentName: contentName || null,
            accessible: hasLabelFor || wrapped || !!aria || !!labelledBy || !!title || !!contentName,
          };
        });
        held = observed.accessible === false;
        break;
      }
      default:
        throw new Error(`unknown assertion kind: ${a.kind}`);
    }

    if (page) await recorder?.shot(page, 'assert');
    return { held, observed, steps, consoleErrors, dialogs, requests, error: null };
  } catch (err) {
    return { held: null, observed: null, steps, consoleErrors, dialogs, requests, error: String(err?.message ?? err) };
  } finally {
    if (context) {
      if (recorder?.traceEnabled) {
        try { await context.tracing.stop({ path: recorder.tracePath() }); } catch { /* best effort */ }
      }
      await context.close().catch(() => {});
    }
  }
}
