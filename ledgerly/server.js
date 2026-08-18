// Ledgerly — a small multi-tenant invoicing SaaS used as the "customer app"
// under evaluation. Defects are seeded deliberately and toggled via LEDGERLY_BUGS.
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeBugs } from './bugs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BUGS = new Set(activeBugs());
const on = (id) => BUGS.has(id);

const PORT = Number(process.env.PORT || 4310);
const SEED_TOKEN = process.env.SEED_TOKEN || 'dev-seed-token';

// ---------------------------------------------------------------- data store
const db = { orgs: [], users: [], customers: [], invoices: [], mailbox: [] };
const sessions = new Map();
const challenges = new Map();
let seq = 1;
const nextId = (p) => `${p}_${String(seq++).padStart(5, '0')}`;

const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');

function resetDb() {
  db.orgs = []; db.users = []; db.customers = []; db.invoices = []; db.mailbox = [];
  sessions.clear(); challenges.clear(); seq = 1;
}

function makeUser(orgId, email, password, name) {
  const salt = crypto.randomBytes(8).toString('hex');
  const u = { id: nextId('usr'), orgId, email, name, salt, pwHash: hash(password, salt) };
  db.users.push(u);
  return u;
}

const NAMES = ['Northwind Traders', 'Acme Robotics', 'Blue Harbor Design', 'Cedar Analytics',
  'Delta Freight', 'Everline Media', 'Foxglove Labs', 'Granite Legal', 'Harbor & Co',
  'Ironwood Studio', 'Juniper Health', 'Kestrel Systems'];

function seed(scenario = 'default') {
  resetDb();
  const orgA = { id: nextId('org'), name: 'Vertex Consulting' };
  const orgB = { id: nextId('org'), name: 'Rival Industries' };
  db.orgs.push(orgA, orgB);

  const owner = makeUser(orgA.id, 'ada@vertex.test', 'Passw0rd!23', 'Ada Reyes');
  const rival = makeUser(orgB.id, 'boris@rival.test', 'Passw0rd!23', 'Boris Vane');
  const empty = scenario === 'empty-org';

  // deterministic pseudo-random so repro runs see identical data
  let s = 42;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;

  const mkCustomers = (org, count) => {
    const out = [];
    for (let i = 0; i < count; i++) {
      const c = {
        id: nextId('cus'), orgId: org.id,
        name: `${NAMES[i % NAMES.length]}${i >= NAMES.length ? ` ${Math.floor(i / NAMES.length) + 1}` : ''}`,
        email: `billing${i}@${NAMES[i % NAMES.length].toLowerCase().replace(/[^a-z]/g, '')}.test`,
      };
      db.customers.push(c); out.push(c);
    }
    return out;
  };

  const custA = mkCustomers(orgA, empty ? 3 : 12);
  const custB = mkCustomers(orgB, 4);

  const mkInvoices = (org, custs, count) => {
    for (let i = 0; i < count; i++) {
      const c = custs[i % custs.length];
      const qty = 1 + Math.floor(rnd() * 4);
      const unit = Math.round((60 + rnd() * 900) * 100) / 100;
      const inv = {
        id: nextId('inv'), orgId: org.id, customerId: c.id,
        number: `${org.id === orgA.id ? 'VC' : 'RI'}-${1000 + i}`,
        description: `Professional services engagement for ${c.name} — milestone ${1 + (i % 5)} deliverable review`,
        qty, unitPrice: unit, taxRate: 0.2,
        status: rnd() > 0.55 ? 'paid' : 'open',
        createdAt: new Date(Date.UTC(2026, 0, 1 + (i % 300))).toISOString(),
      };
      recalcInvoice(inv);
      db.invoices.push(inv);
    }
  };

  mkInvoices(orgA, custA, empty ? 0 : 260);
  mkInvoices(orgB, custB, 8);

  return {
    scenario,
    seedToken: SEED_TOKEN,
    orgs: { primary: orgA, secondary: orgB },
    users: {
      primary: { email: owner.email, password: 'Passw0rd!23', orgId: orgA.id, name: owner.name },
      secondary: { email: rival.email, password: 'Passw0rd!23', orgId: orgB.id, name: rival.name },
    },
    // Handed to the evaluator so cross-tenant access-control probes have a real target.
    fixtures: {
      foreignInvoiceId: db.invoices.find((i) => i.orgId === orgB.id)?.id ?? null,
      foreignInvoiceNumber: db.invoices.find((i) => i.orgId === orgB.id)?.number ?? null,
      primaryCustomerWithInvoices: custA[0]?.id ?? null,
      primaryInvoiceCount: db.invoices.filter((i) => i.orgId === orgA.id).length,
    },
    activeBugs: [...BUGS],
  };
}

// BUG-001: tax applied to unitPrice rather than the line total (qty * unitPrice).
function recalcInvoice(inv) {
  const subtotal = round2(inv.qty * inv.unitPrice);
  const tax = on('BUG-001')
    ? round2(inv.unitPrice * inv.taxRate)
    : round2(subtotal * inv.taxRate);
  inv.subtotal = subtotal;
  inv.tax = tax;
  inv.total = round2(subtotal + tax);
}
const round2 = (n) => Math.round(n * 100) / 100;

// ------------------------------------------------------------------- helpers
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const raw = req.headers.cookie || '';
  req.cookies = Object.fromEntries(raw.split(';').map((c) => c.trim().split('=')).filter((p) => p[0]));
  next();
});

function currentUser(req) {
  const sid = req.cookies?.sid;
  if (!sid) return null;
  const sess = sessions.get(sid);
  if (!sess || sess.expiresAt < Date.now()) { sessions.delete(sid); return null; }
  return db.users.find((u) => u.id === sess.userId) ?? null;
}
function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'not_authenticated' });
  req.user = u;
  next();
}
const publicCustomer = (c) => ({ id: c.id, name: c.name, email: c.email });
function publicInvoice(inv) {
  const c = db.customers.find((x) => x.id === inv.customerId);
  return {
    id: inv.id, number: inv.number, description: inv.description,
    // BUG-003: orphaned invoices emit customer:null and the client dereferences it.
    customer: c ? publicCustomer(c) : null,
    qty: inv.qty, unitPrice: inv.unitPrice, taxRate: inv.taxRate,
    subtotal: inv.subtotal, tax: inv.tax, total: inv.total,
    status: inv.status, createdAt: inv.createdAt,
  };
}

// --------------------------------------------------------------- test harness
// Deterministic seeding + an OTP mailbox. This is the contract an evaluation
// agent needs in order to authenticate and to reproduce findings from a known
// state; it is token-gated so it is inert without the harness secret.
function requireSeedToken(req, res, next) {
  if (req.headers['x-seed-token'] !== SEED_TOKEN) return res.status(403).json({ error: 'bad_seed_token' });
  next();
}
app.post('/api/test/seed', requireSeedToken, (req, res) => res.json(seed(req.body?.scenario || 'default')));
app.get('/api/test/mailbox', requireSeedToken, (req, res) => {
  const email = String(req.query.email || '').toLowerCase();
  const msgs = db.mailbox.filter((m) => m.to.toLowerCase() === email).sort((a, b) => b.sentAt - a.sentAt);
  res.json({ messages: msgs.slice(0, 10) });
});
app.get('/api/test/health', (_req, res) => res.json({ ok: true, activeBugs: [...BUGS] }));
// Runtime defect toggle. Lets the evaluator attribute a confirmed finding to a
// specific seeded defect by re-running its probe with one defect enabled at a
// time — the ground-truth oracle behind the recall and false-positive numbers.
app.post('/api/test/bugs', requireSeedToken, (req, res) => {
  const next = Array.isArray(req.body?.bugs) ? req.body.bugs : [];
  BUGS.clear();
  for (const b of next) BUGS.add(String(b));
  res.json({ ok: true, activeBugs: [...BUGS] });
});

// ------------------------------------------------------------------ auth flow
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = db.users.find((x) => x.email.toLowerCase() === String(email || '').toLowerCase());
  if (!u || hash(String(password || ''), u.salt) !== u.pwHash) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const challengeId = crypto.randomUUID();
  challenges.set(challengeId, { userId: u.id, code, expiresAt: Date.now() + 5 * 60_000, attempts: 0 });
  db.mailbox.push({
    id: nextId('msg'), to: u.email, sentAt: Date.now(),
    subject: 'Your Ledgerly verification code',
    body: `Your verification code is ${code}. It expires in 5 minutes.`,
    code,
  });
  res.json({ otpRequired: true, challengeId, sentTo: u.email.replace(/(.).*(@.*)/, '$1***$2') });
});

app.post('/api/auth/verify-otp', (req, res) => {
  const { challengeId, code } = req.body || {};
  const ch = challenges.get(String(challengeId || ''));
  if (!ch) return res.status(400).json({ error: 'unknown_challenge' });

  // BUG-004: expiry and the attempt cap are only enforced in the fixed build.
  if (!on('BUG-004')) {
    if (ch.expiresAt < Date.now()) { challenges.delete(challengeId); return res.status(400).json({ error: 'challenge_expired' }); }
    if (ch.attempts >= 5) { challenges.delete(challengeId); return res.status(429).json({ error: 'too_many_attempts' }); }
  }
  ch.attempts += 1;
  if (String(code || '') !== ch.code) {
    return res.status(401).json({ error: 'invalid_code', attempts: ch.attempts });
  }
  challenges.delete(challengeId);
  const sid = crypto.randomUUID();
  sessions.set(sid, { userId: ch.userId, expiresAt: Date.now() + 60 * 60_000 });
  res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  const u = db.users.find((x) => x.id === ch.userId);
  res.json({ ok: true, user: { id: u.id, email: u.email, name: u.name, orgId: u.orgId } });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.cookies?.sid) sessions.delete(req.cookies.sid);
  res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', requireAuth, (req, res) => {
  const org = db.orgs.find((o) => o.id === req.user.orgId);
  res.json({ id: req.user.id, email: req.user.email, name: req.user.name, org });
});

// ------------------------------------------------------------------ customers
app.get('/api/customers', requireAuth, (req, res) => {
  res.json({ customers: db.customers.filter((c) => c.orgId === req.user.orgId).map(publicCustomer) });
});
app.post('/api/customers', requireAuth, (req, res) => {
  const { name, email } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name_required' });
  const c = { id: nextId('cus'), orgId: req.user.orgId, name: String(name).trim(), email: String(email || '') };
  db.customers.push(c);
  res.status(201).json(publicCustomer(c));
});
app.delete('/api/customers/:id', requireAuth, (req, res) => {
  const idx = db.customers.findIndex((c) => c.id === req.params.id && c.orgId === req.user.orgId);
  if (idx === -1) return res.status(404).json({ error: 'not_found' });
  const [removed] = db.customers.splice(idx, 1);
  if (!on('BUG-003')) {
    // fixed build: cascade so no invoice is left pointing at a missing customer
    db.invoices = db.invoices.filter((i) => i.customerId !== removed.id);
  }
  res.json({ ok: true, deleted: removed.id });
});

// ------------------------------------------------------------------- invoices
const levenshtein = (a, b) => {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
};

app.get('/api/invoices', requireAuth, (req, res) => {
  const search = String(req.query.search || '').trim().toLowerCase();
  const status = String(req.query.status || 'all').toLowerCase();
  const page = Math.max(1, Number(req.query.page || 1));
  const perPage = 20;
  let rows = db.invoices.filter((i) => i.orgId === req.user.orgId);
  if (status === 'open' || status === 'paid') rows = rows.filter((i) => i.status === status);

  if (search) {
    if (on('BUG-007')) {
      // BUG-007: "fuzzy" search scores every invoice against every other invoice.
      rows = rows.filter((inv) => {
        let best = Infinity;
        for (const other of db.invoices) {
          if (other.orgId !== req.user.orgId) continue;
          best = Math.min(best, levenshtein(inv.description.toLowerCase().slice(0, 64), other.description.toLowerCase().slice(0, 64)));
        }
        return inv.description.toLowerCase().includes(search)
          || inv.number.toLowerCase().includes(search)
          || best < 0; // never true — the scan is pure waste
      });
    } else {
      rows = rows.filter((inv) =>
        inv.description.toLowerCase().includes(search) || inv.number.toLowerCase().includes(search));
    }
  }
  rows.sort((a, b) => (a.number < b.number ? -1 : 1));
  const total = rows.length;
  res.json({
    invoices: rows.slice((page - 1) * perPage, page * perPage).map(publicInvoice),
    page, perPage, total, totalPages: Math.max(1, Math.ceil(total / perPage)),
  });
});

app.get('/api/invoices/:id', requireAuth, (req, res) => {
  // BUG-002: org scoping omitted, so any authenticated user can read any invoice.
  const inv = on('BUG-002')
    ? db.invoices.find((i) => i.id === req.params.id)
    : db.invoices.find((i) => i.id === req.params.id && i.orgId === req.user.orgId);
  if (!inv) return res.status(404).json({ error: 'not_found' });
  res.json(publicInvoice(inv));
});

app.post('/api/invoices', requireAuth, (req, res) => {
  const { customerId, description, qty, unitPrice, taxRate } = req.body || {};
  const cust = db.customers.find((c) => c.id === customerId && c.orgId === req.user.orgId);
  if (!cust) return res.status(400).json({ error: 'customer_required' });
  const q = Number(qty), up = Number(unitPrice);
  if (!Number.isFinite(q) || q < 1) return res.status(400).json({ error: 'qty_invalid' });
  if (!Number.isFinite(up) || up <= 0) return res.status(400).json({ error: 'unit_price_invalid' });
  if (!description || !String(description).trim()) return res.status(400).json({ error: 'description_required' });

  // BUG-005: the fixed build de-duplicates identical rapid submissions.
  if (!on('BUG-005')) {
    const recent = db.invoices.find((i) =>
      i.orgId === req.user.orgId && i.customerId === customerId &&
      i.description === String(description).trim() && i.qty === q && i.unitPrice === up &&
      Date.now() - new Date(i.createdAt).getTime() < 5000);
    if (recent) return res.status(200).json(publicInvoice(recent));
  }
  const inv = {
    id: nextId('inv'), orgId: req.user.orgId, customerId,
    number: `VC-${2000 + db.invoices.filter((i) => i.orgId === req.user.orgId).length}`,
    description: String(description).trim(), qty: q, unitPrice: up,
    taxRate: Number.isFinite(Number(taxRate)) ? Number(taxRate) : 0.2,
    status: 'open', createdAt: new Date().toISOString(),
  };
  recalcInvoice(inv);
  db.invoices.push(inv);
  res.status(201).json(publicInvoice(inv));
});

app.post('/api/invoices/:id/pay', requireAuth, (req, res) => {
  const inv = db.invoices.find((i) => i.id === req.params.id && i.orgId === req.user.orgId);
  if (!inv) return res.status(404).json({ error: 'not_found' });
  inv.status = 'paid';
  res.json(publicInvoice(inv));
});

app.use(express.static(path.join(here, 'public')));
app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(here, 'public', 'index.html')));

seed('default');
app.listen(PORT, () => {
  console.log(`ledgerly listening on http://127.0.0.1:${PORT}  bugs=${[...BUGS].join(',') || 'none'}`);
});
