// The browser tool surface handed to each dimension agent, exposed as an
// in-process MCP server (the same shape Playwright MCP would present, minus the
// subprocess). One live browser context per agent, so an agent's exploration is
// a continuous session rather than a series of cold starts.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { runProbe } from './probe.js';

const ok = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: `ERROR: ${msg}` }], isError: true });
const clip = (s, n = 4000) => (s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s);

export class BrowserSession {
  constructor({ harness, browser, recorder }) {
    this.harness = harness;
    this.browser = browser;
    this.recorder = recorder;
    this.context = null;
    this.page = null;
    this.role = null;
    this.consoleErrors = [];
    this.dialogs = [];
    this.network = [];
    this.cookies = {};
    this.actions = 0;
  }

  async ensure(role = 'primary') {
    if (this.page && this.role === role) return this.page;
    if (this.context) { await this.context.close().catch(() => {}); this.context = null; }
    const storageState = await this.harness.storageState(role);
    this.context = await this.browser.newContext({
      storageState,
      viewport: { width: 1280, height: 800 },
      recordVideo: this.recorder?.videoDir ? { dir: this.recorder.videoDir, size: { width: 1280, height: 800 } } : undefined,
    });
    if (this.recorder?.traceEnabled) {
      await this.context.tracing.start({ screenshots: true, snapshots: true }).catch(() => {});
      this._tracing = true;
    }
    this.page = await this.context.newPage();
    this.role = role;
    // A real user clicks OK. Playwright dismisses dialogs by default, which
    // would make every confirm-guarded action appear to silently do nothing.
    this.page.on('dialog', async (d) => {
      this.dialogs.push({ type: d.type(), message: d.message(), accepted: true, at: Date.now() });
      this.record('dialog_accepted', { message: d.message() });
      try { await d.accept(); } catch { /* already handled */ }
    });
    this.page.on('console', (m) => { if (m.type() === 'error') this.consoleErrors.push({ text: m.text(), at: Date.now() }); });
    this.page.on('pageerror', (e) => this.consoleErrors.push({ text: String(e?.message ?? e), at: Date.now() }));
    this.page.on('response', (r) => this.network.push({ url: r.url(), status: r.status() }));
    return this.page;
  }

  async cookieFor(role) {
    return (this.cookies[role] ??= (await this.harness.loginApi(role)).cookie);
  }

  record(op, detail) {
    this.actions += 1;
    this.recorder?.step({ n: this.actions, op, ...detail, at: new Date().toISOString() });
  }

  async close() {
    if (this.context) {
      if (this._tracing) { try { await this.context.tracing.stop({ path: this.recorder.tracePath() }); } catch { /* ignore */ } }
      await this.context.close().catch(() => {});
      this.context = null; this.page = null;
    }
  }
}

/** Structured, selector-bearing view of the page — the agent's eyes. */
async function snapshot(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const sel = (el) => {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const t = el.getAttribute('data-testid');
      if (t) return `[data-testid="${t}"]`;
      const cls = (el.className || '').toString().trim().split(/\s+/).filter(Boolean)[0];
      const base = cls ? `${el.tagName.toLowerCase()}.${CSS.escape(cls)}` : el.tagName.toLowerCase();
      const sibs = [...document.querySelectorAll(base)];
      return sibs.length > 1 ? `${base}:nth-of-type(${sibs.indexOf(el) + 1})` : base;
    };
    const interactive = [...document.querySelectorAll('a,button,input,select,textarea,[role=button],[role=dialog]')]
      .filter(vis).slice(0, 60).map((el) => {
        const id = el.getAttribute('id');
        const hasLabelFor = id ? !!document.querySelector(`label[for="${CSS.escape(id)}"]`) : false;
        const tag = el.tagName.toLowerCase();
        const fromContent = ['button', 'a', 'summary'].includes(tag)
          || ['button', 'link', 'tab'].includes(el.getAttribute('role'));
        return {
          tag,
          type: el.getAttribute('type') || undefined,
          selector: sel(el),
          text: (el.innerText || el.value || '').trim().slice(0, 60) || undefined,
          accessibleName: el.getAttribute('aria-label')
            || (hasLabelFor ? document.querySelector(`label[for="${CSS.escape(id)}"]`).innerText.trim() : null)
            || (el.closest('label')?.innerText?.trim() ?? null)
            || (fromContent ? ((el.innerText || '').trim() || null) : null),
          disabled: el.disabled || undefined,
        };
      });
    const rows = [...document.querySelectorAll('tbody tr')].slice(0, 12)
      .map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.trim().replace(/\s+/g, ' ').slice(0, 60)));
    return {
      url: location.pathname + location.search,
      title: document.title,
      headings: [...document.querySelectorAll('h1,h2')].filter(vis).map((h) => h.innerText.trim()).slice(0, 8),
      interactive,
      tableRows: rows,
      visibleText: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 1200),
    };
  });
}

export function createBrowserServer(session) {
  const { harness } = session;

  return createSdkMcpServer({
    name: 'browser',
    version: '0.1.0',
    instructions: 'Drive the application under test as a real user would, and make authenticated API calls to corroborate what the UI shows.',
    tools: [
      tool('seed_app', 'Reset the app to a deterministic fixture and return credentials, fixture ids and counts. Call this before an independent line of investigation.',
        { scenario: z.enum(['default', 'empty-org']).optional().describe('fixture variant') },
        async ({ scenario }) => {
          const data = await harness.seed(scenario || 'default');
          session.record('seed_app', { scenario: scenario || 'default' });
          return ok({
            scenario: data.scenario, orgs: data.orgs, users: data.users, fixtures: data.fixtures,
            note: 'Log in with users.primary. users.secondary belongs to a different tenant.',
          });
        }),

      tool('open_page', 'Navigate the browser to a path, already authenticated as the given role.',
        {
          path: z.string().describe('e.g. /app, /customers, /login'),
          as: z.enum(['primary', 'secondary']).optional().describe('which tenant user to browse as (default primary)'),
        },
        async ({ path, as }) => {
          try {
            const page = await session.ensure(as || 'primary');
            await page.goto(`${harness.baseUrl}${path}`, { waitUntil: 'networkidle', timeout: 20_000 });
            session.record('open_page', { path, as: as || 'primary' });
            await session.recorder?.shot(page, `open${path.replace(/\W+/g, '_')}`);
            return ok(await snapshot(page));
          } catch (e) { return fail(String(e.message ?? e)); }
        }),

      tool('snapshot', 'Read the current page: headings, interactive elements with selectors and accessible names, table rows, visible text.',
        {},
        async () => {
          if (!session.page) return fail('no page open — call open_page first');
          return ok(await snapshot(session.page));
        }),

      tool('click', 'Click an element by CSS selector or by visible text.',
        {
          selector: z.string().optional().describe('CSS selector, preferred'),
          text: z.string().optional().describe('visible text, used when no selector is given'),
        },
        async ({ selector, text }) => {
          if (!session.page) return fail('no page open');
          try {
            const loc = selector ? session.page.locator(selector).first() : session.page.getByText(text, { exact: false }).first();
            await loc.click({ timeout: 10_000 });
            await session.page.waitForTimeout(300);
            session.record('click', { selector, text });
            await session.recorder?.shot(session.page, 'click');
            return ok(await snapshot(session.page));
          } catch (e) { return fail(String(e.message ?? e)); }
        }),

      tool('fill', 'Type a value into an input identified by CSS selector.',
        { selector: z.string(), value: z.string() },
        async ({ selector, value }) => {
          if (!session.page) return fail('no page open');
          try {
            await session.page.locator(selector).first().fill(value, { timeout: 10_000 });
            session.record('fill', { selector, value });
            return ok(`filled ${selector}`);
          } catch (e) { return fail(String(e.message ?? e)); }
        }),

      tool('set_viewport', 'Resize the viewport, e.g. to check a 375x812 phone layout.',
        { width: z.number(), height: z.number() },
        async ({ width, height }) => {
          if (!session.page) return fail('no page open');
          await session.page.setViewportSize({ width, height });
          session.record('set_viewport', { width, height });
          await session.recorder?.shot(session.page, `viewport_${width}x${height}`);
          return ok(await snapshot(session.page));
        }),

      tool('select_option', 'Choose an option in a <select> dropdown. Required for the customer picker on the invoice form — typing into a select does not work.',
        {
          selector: z.string(),
          value: z.string().optional().describe('option value attribute'),
          label: z.string().optional().describe('visible option text, if you do not know the value'),
        },
        async ({ selector, value, label }) => {
          if (!session.page) return fail('no page open');
          try {
            const loc = session.page.locator(selector).first();
            await loc.selectOption(value !== undefined ? { value } : { label }, { timeout: 10_000 });
            await session.page.waitForTimeout(250);
            session.record('select_option', { selector, value, label });
            const chosen = await loc.evaluate((el) => ({ value: el.value, text: el.selectedOptions[0]?.text ?? null }));
            return ok({ chosen, page: await snapshot(session.page) });
          } catch (e) { return fail(String(e.message ?? e)); }
        }),

      tool('press_key', 'Press a key, optionally focused on an element. Use Tab/Shift+Tab to walk the keyboard order, Enter/Space to activate.',
        { key: z.string().describe('e.g. Tab, Enter, Escape, ArrowDown'), selector: z.string().optional() },
        async ({ key, selector }) => {
          if (!session.page) return fail('no page open');
          try {
            if (selector) await session.page.locator(selector).first().press(key);
            else await session.page.keyboard.press(key);
            await session.page.waitForTimeout(150);
            session.record('press_key', { key, selector });
            const focus = await session.page.evaluate(() => {
              const el = document.activeElement;
              if (!el || el === document.body) return null;
              return {
                tag: el.tagName.toLowerCase(), id: el.id || null,
                text: (el.innerText || el.value || '').trim().slice(0, 60),
                ariaLabel: el.getAttribute('aria-label'),
                focusVisible: (() => { try { return el.matches(':focus-visible'); } catch { return null; } })(),
              };
            });
            return ok({ focusedAfterKey: focus, page: await snapshot(session.page) });
          } catch (e) { return fail(String(e.message ?? e)); }
        }),

      tool('go_back', 'Navigate back in browser history — use to check that the back button behaves sanely after a flow.',
        {},
        async () => {
          if (!session.page) return fail('no page open');
          try {
            await session.page.goBack({ waitUntil: 'networkidle', timeout: 15_000 });
            session.record('go_back', {});
            return ok(await snapshot(session.page));
          } catch (e) { return fail(String(e.message ?? e)); }
        }),

      tool('inspect_element', 'Geometry and accessible-name resolution for one element. Use for layout overflow and labelling questions.',
        { selector: z.string() },
        async ({ selector }) => {
          if (!session.page) return fail('no page open');
          try {
            const info = await session.page.locator(selector).first().evaluate((el) => {
              const r = el.getBoundingClientRect();
              const id = el.getAttribute('id');
              const labelFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
              return {
                rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), right: Math.round(r.right) },
                viewport: { width: window.innerWidth, height: window.innerHeight },
                overflowPx: Math.round(Math.max(0, r.right - window.innerWidth, -r.left)),
                labelFor: labelFor ? labelFor.innerText.trim() : null,
                wrappedInLabel: !!el.closest('label'),
                ariaLabel: el.getAttribute('aria-label'),
                ariaLabelledby: el.getAttribute('aria-labelledby'),
                ariaDescribedby: el.getAttribute('aria-describedby'),
                role: el.getAttribute('role'),
                namesFromOwnContent: ['button', 'a', 'summary', 'label', 'legend'].includes(el.tagName.toLowerCase())
                  || ['button', 'link', 'tab', 'menuitem', 'heading'].includes(el.getAttribute('role')),
                accessibleName: el.getAttribute('aria-label')
                  || (labelFor ? labelFor.innerText.trim() : null)
                  || (el.closest('label')?.innerText?.trim() ?? null)
                  || ((['button', 'a', 'summary'].includes(el.tagName.toLowerCase())
                       || ['button', 'link', 'tab'].includes(el.getAttribute('role')))
                      ? ((el.innerText || '').trim() || null) : null),
              };
            });
            session.record('inspect_element', { selector });
            return ok(info);
          } catch (e) { return fail(String(e.message ?? e)); }
        }),

      tool('read_console', 'Console errors, page exceptions, and any browser confirm/alert dialogs captured so far in this session.',
        {},
        async () => ok({
          errors: session.consoleErrors.slice(-25), count: session.consoleErrors.length,
          dialogs: session.dialogs.slice(-10),
          note: 'Confirmation dialogs are accepted automatically, as a real user clicking OK would.',
        })),

      tool('api_request', 'Call the app API directly, authenticated as a role. Use to corroborate UI observations and to probe access control.',
        {
          method: z.enum(['GET', 'POST', 'DELETE', 'PATCH']),
          path: z.string().describe('e.g. /api/invoices?search=milestone'),
          as: z.enum(['primary', 'secondary', 'none']).optional(),
          body: z.record(z.string(), z.any()).optional(),
        },
        async ({ method, path, as, body }) => {
          try {
            const headers = { 'content-type': 'application/json' };
            const role = as || 'primary';
            if (role !== 'none') headers.cookie = await session.cookieFor(role);
            const t0 = performance.now();
            const res = await fetch(`${harness.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
            const ms = Math.round(performance.now() - t0);
            const text = await res.text();
            session.record('api_request', { method, path, as: role, status: res.status, ms });
            return ok({ status: res.status, elapsedMs: ms, body: clip(text, 3000) });
          } catch (e) { return fail(String(e.message ?? e)); }
        }),

      tool('check_probe', 'Dry-run a probe exactly as the verifier will, in a separate browser context from a fresh seed, and report whether its assertion held. Use this on EVERY probe before you report it — a probe that errors or does not hold gets your finding discarded.',
        {
          steps: z.array(z.record(z.string(), z.any())).describe('probe steps, same format as in your finding'),
          assert: z.record(z.string(), z.any()).describe('the single assertion, true when the defect is present'),
        },
        async ({ steps, assert }) => {
          try {
            const r = await runProbe({ steps, assert }, { harness, browser: session.browser, recorder: null });
            session.record('check_probe', { assert: assert?.kind, held: r.held, error: r.error });
            await harness.seed('default');   // leave the fixture clean for further exploration
            if (r.error) {
              return ok({
                usable: false, error: r.error,
                advice: 'The probe could not run. A common cause is asserting on an element that is not present yet or not present at all — add a wait or waitForText step, or target an element that always exists.',
              });
            }
            if (r.held !== true) {
              return ok({
                usable: false, held: r.held, observed: r.observed,
                advice: 'The probe ran but the assertion did not hold, so the verifier would discard this finding. Either the defect is not what you think, or the assertion describes the healthy state instead of the broken one.',
              });
            }
            return ok({ usable: true, held: true, observed: r.observed, stepsRun: r.steps.length });
          } catch (e) { return fail(String(e.message ?? e)); }
        }),

      tool('screenshot', 'Capture the viewport now and attach it to this agent\'s evidence bundle.',
        { label: z.string().describe('short label, e.g. modal-overflow') },
        async ({ label }) => {
          if (!session.page) return fail('no page open');
          const rel = await session.recorder?.shot(session.page, label);
          return ok({ saved: rel });
        }),
    ],
  });
}
