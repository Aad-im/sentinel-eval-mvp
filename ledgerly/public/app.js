// Ledgerly SPA. Client-side defects are gated on the server's active bug set so
// the same bundle can serve the buggy and the fixed build.
const $ = (sel, el = document) => el.querySelector(sel);
const root = document.getElementById('root');
const money = (n) => '$' + Number(n).toFixed(2);

let BUGS = new Set();
const bug = (id) => BUGS.has(id);

const state = { user: null, route: location.pathname, invoices: null, customers: [], page: 1, search: '', status: 'all', modal: null, detail: null, saving: false };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  let body = null;
  try { body = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw Object.assign(new Error(body?.error || `http_${res.status}`), { status: res.status, body });
  return body;
}

function go(path) { history.pushState({}, '', path); state.route = path; render(); }
window.addEventListener('popstate', () => { state.route = location.pathname; render(); });

// ------------------------------------------------------------------- screens
function loginScreen() {
  const stage = state.loginStage || 'credentials';
  root.innerHTML = `
    <div class="center"><div class="panel card">
      <h1>Sign in to Ledgerly</h1>
      <p class="sub">${stage === 'credentials' ? 'Use your work email.' : 'Enter the 6-digit code we emailed you.'}</p>
      ${stage === 'credentials' ? `
        <form id="cred">
          <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required /></div>
          <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required /></div>
          <button class="primary" type="submit" style="width:100%">Continue</button>
          <div class="error" id="err" role="alert">${state.loginError || ''}</div>
        </form>` : `
        <form id="otp">
          <div class="field"><label for="code">Verification code</label>
            <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required /></div>
          <button class="primary" type="submit" style="width:100%">Verify</button>
          <div class="error" id="err" role="alert">${state.loginError || ''}</div>
        </form>`}
    </div></div>`;

  if (stage === 'credentials') {
    $('#cred').addEventListener('submit', async (e) => {
      e.preventDefault();
      state.loginError = '';
      try {
        const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: $('#email').value, password: $('#password').value }) });
        state.challengeId = r.challengeId;
        state.loginStage = 'otp';
      } catch (err) {
        state.loginError = err.status === 401 ? 'That email and password did not match.' : 'Sign-in failed. Try again.';
      }
      render();
    });
  } else {
    $('#otp').addEventListener('submit', async (e) => {
      e.preventDefault();
      state.loginError = '';
      try {
        await api('/api/auth/verify-otp', { method: 'POST', body: JSON.stringify({ challengeId: state.challengeId, code: $('#code').value }) });
        state.loginStage = 'credentials';
        await boot();
        go('/app');
        return;
      } catch (err) {
        state.loginError = err.body?.error === 'invalid_code' ? 'That code is not correct.' : 'Verification failed.';
      }
      render();
    });
  }
}

function chrome(inner) {
  return `
    <div class="topbar">
      <span class="brand">Ledgerly</span>
      <nav>
        <a href="/app" data-nav class="${state.route === '/app' ? 'active' : ''}">Invoices</a>
        <a href="/customers" data-nav class="${state.route === '/customers' ? 'active' : ''}">Customers</a>
      </nav>
      <span class="spacer"></span>
      <span class="sub" style="margin:0">${state.user?.name ?? ''} · ${state.user?.org?.name ?? ''}</span>
      <button id="logout">Sign out</button>
    </div>
    <div class="wrap">${inner}</div>`;
}

function invoiceRows() {
  if (!state.invoices) return '<tr><td colspan="5" class="empty">Loading…</td></tr>';
  if (!state.invoices.invoices.length) {
    return `<tr><td colspan="5" class="empty" data-testid="empty-state">No invoices yet. Create your first one.</td></tr>`;
  }
  return state.invoices.invoices.map((inv) => {
    // BUG-003: an orphaned invoice has customer === null and this throws,
    // aborting the whole render so the table silently stays empty.
    const customerName = bug('BUG-003') ? inv.customer.name : (inv.customer?.name ?? '(deleted customer)');
    return `<tr data-invoice="${inv.id}" class="clickable" tabindex="0" role="button" aria-label="Open invoice ${inv.number}">
      <td><strong>${inv.number}</strong><div class="sub" style="margin:0;font-size:13px">${inv.description}</div></td>
      <td>${customerName}</td>
      <td>${inv.qty} × ${money(inv.unitPrice)}</td>
      <td data-testid="total-${inv.number}">${money(inv.total)}</td>
      <td><span class="pill ${inv.status}">${inv.status}</span></td>
    </tr>`;
  }).join('');
}

function invoicesScreen() {
  const inv = state.invoices;
  root.innerHTML = chrome(`
    <h1>Invoices</h1>
    <p class="sub">${inv ? `${inv.total} invoice(s)` : 'Loading…'}</p>
    <div class="panel">
      <div class="row" style="margin-bottom:16px">
        <input id="search" placeholder="Search invoices…" value="${state.search}" aria-label="Search invoices" style="max-width:280px" />
        <button id="do-search">Search</button>
        <label for="status-filter" class="sub" style="margin:0">Status</label>
        <select id="status-filter" aria-label="Filter by status" style="width:auto">
          <option value="all"${state.status === 'all' ? ' selected' : ''}>All</option>
          <option value="open"${state.status === 'open' ? ' selected' : ''}>Open</option>
          <option value="paid"${state.status === 'paid' ? ' selected' : ''}>Paid</option>
        </select>
        <span class="spacer" style="flex:1"></span>
        <button class="primary" id="new-invoice">New invoice</button>
      </div>
      <table>
        <thead><tr><th>Invoice</th><th>Customer</th><th>Line</th><th>Total</th><th>Status</th></tr></thead>
        <tbody id="rows">${invoiceRows()}</tbody>
      </table>
      ${inv ? `<div class="row" style="margin-top:16px;justify-content:flex-end">
        <button id="prev" ${inv.page <= 1 ? 'disabled' : ''}>Previous</button>
        <span class="sub" style="margin:0" data-testid="page-label">Page ${inv.page} of ${inv.totalPages}</span>
        <button id="next" ${inv.page >= inv.totalPages ? 'disabled' : ''}>Next</button>
      </div>` : ''}
    </div>
    ${state.modal === 'invoice' ? invoiceModal() : ''}
    ${state.modal === 'detail' ? detailModal() : ''}`);
  wireChrome();

  $('#do-search')?.addEventListener('click', () => { state.search = $('#search').value; state.page = 1; loadInvoices(); });
  $('#search')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { state.search = e.target.value; state.page = 1; loadInvoices(); } });
  $('#new-invoice')?.addEventListener('click', () => { state.modal = 'invoice'; state.formError = ''; render(); });
  $('#prev')?.addEventListener('click', () => { state.page = Math.max(1, state.page - 1); loadInvoices(); });
  $('#next')?.addEventListener('click', () => { state.page += 1; loadInvoices(); });
  $('#status-filter')?.addEventListener('change', (e) => { state.status = e.target.value; state.page = 1; loadInvoices(); });
  root.querySelectorAll('tr[data-invoice]').forEach((tr) => {
    const open = () => openDetail(tr.dataset.invoice);
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
  if (state.modal === 'invoice') wireInvoiceModal();
  if (state.modal === 'detail') wireDetailModal();
}


async function openDetail(id) {
  state.detail = null; state.modal = 'detail'; render();
  try { state.detail = await api(`/api/invoices/${id}`); }
  catch (err) { state.detail = { error: err.body?.error || err.message }; }
  render();
}

function detailModal() {
  const d = state.detail;
  if (!d) return `<div class="backdrop" data-testid="detail-modal"><div class="modal"><p class="empty">Loading…</p></div></div>`;
  if (d.error) return `<div class="backdrop" data-testid="detail-modal"><div class="modal">
      <h2>Invoice unavailable</h2><div class="error" role="alert">${d.error}</div>
      <footer><button id="detail-close">Close</button></footer></div></div>`;
  return `
  <div class="backdrop" data-testid="detail-modal">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="detail-title">
      <h2 id="detail-title">Invoice ${d.number}</h2>
      <p class="sub">${d.description}</p>
      <table>
        <tbody>
          <tr><td>Customer</td><td data-testid="detail-customer">${d.customer?.name ?? '(deleted customer)'}</td></tr>
          <tr><td>Quantity</td><td data-testid="detail-qty">${d.qty}</td></tr>
          <tr><td>Unit price</td><td data-testid="detail-unit">${money(d.unitPrice)}</td></tr>
          <tr><td>Subtotal</td><td data-testid="detail-subtotal">${money(d.subtotal)}</td></tr>
          <tr><td>Tax (${(d.taxRate * 100).toFixed(0)}%)</td><td data-testid="detail-tax">${money(d.tax)}</td></tr>
          <tr><td><strong>Total</strong></td><td data-testid="detail-total"><strong>${money(d.total)}</strong></td></tr>
          <tr><td>Status</td><td><span class="pill ${d.status}" data-testid="detail-status">${d.status}</span></td></tr>
        </tbody>
      </table>
      <footer>
        <button id="detail-close">Close</button>
        ${d.status === 'paid' ? '' : '<button class="primary" id="mark-paid">Mark as paid</button>'}
      </footer>
    </div>
  </div>`;
}

function wireDetailModal() {
  $('#detail-close')?.addEventListener('click', () => { state.modal = null; state.detail = null; render(); });
  $('#mark-paid')?.addEventListener('click', async () => {
    await api(`/api/invoices/${state.detail.id}/pay`, { method: 'POST' });
    state.detail = await api(`/api/invoices/${state.detail.id}`);
    render();
    await loadInvoices();
  });
}

function invoiceModal() {
  // BUG-006: qty and unit price have no programmatic label, and the error text
  // is neither role=alert nor referenced by aria-describedby.
  const labelled = !bug('BUG-006');
  return `
  <div class="backdrop" data-testid="invoice-modal">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <h2 id="modal-title">New invoice</h2>
      <form id="invoice-form">
        <div class="field">
          <label for="customer">Customer</label>
          <select id="customer" name="customer">
            ${state.customers.map((c) => `<option value="${c.id}">${c.name}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="description">Description</label>
          <input id="description" name="description" />
        </div>
        <div class="row">
          <div class="field" style="flex:1">
            ${labelled ? '<label for="qty">Quantity</label>' : '<div class="sub" style="font-size:13px;margin-bottom:5px">Quantity</div>'}
            <input id="qty" name="qty" type="number" min="1" value="1"
              ${labelled ? 'aria-describedby="form-error"' : ''} />
          </div>
          <div class="field" style="flex:1">
            ${labelled ? '<label for="unitPrice">Unit price</label>' : '<div class="sub" style="font-size:13px;margin-bottom:5px">Unit price</div>'}
            <input id="unitPrice" name="unitPrice" type="number" step="0.01"
              ${labelled ? 'aria-describedby="form-error"' : ''} />
          </div>
        </div>
        <div class="error" id="form-error" ${labelled ? 'role="alert"' : ''} data-testid="form-error">${state.formError || ''}</div>
        <footer>
          <button type="button" id="cancel">Cancel</button>
          <button class="primary" type="submit" id="save-invoice" ${!bug('BUG-005') && state.saving ? 'disabled' : ''}>Save invoice</button>
        </footer>
      </form>
    </div>
  </div>`;
}

function wireInvoiceModal() {
  $('#cancel').addEventListener('click', () => { state.modal = null; render(); });
  $('#invoice-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      customerId: $('#customer').value,
      description: $('#description').value,
      qty: Number($('#qty').value),
      unitPrice: Number($('#unitPrice').value),
      taxRate: 0.2,
    };
    if (!payload.description.trim()) { state.formError = 'Description is required.'; return render(); }
    if (!(payload.unitPrice > 0)) { state.formError = 'Unit price must be greater than zero.'; return render(); }
    // BUG-005: the guard that blocks a second in-flight submit is absent.
    if (!bug('BUG-005')) { state.saving = true; render(); }
    try {
      await api('/api/invoices', { method: 'POST', body: JSON.stringify(payload) });
      state.modal = null; state.formError = '';
    } catch (err) {
      state.formError = `Could not save invoice (${err.body?.error || err.message}).`;
    } finally {
      state.saving = false;
    }
    await loadInvoices();
  });
}

function customersScreen() {
  root.innerHTML = chrome(`
    <h1>Customers</h1>
    <p class="sub">${state.customers.length} customer(s)</p>
    <div class="panel">
      <form id="add-customer" class="row" style="margin-bottom:18px">
        <div style="flex:1"><label for="cname" class="sub" style="font-size:13px">Name</label><input id="cname" /></div>
        <div style="flex:1"><label for="cemail" class="sub" style="font-size:13px">Billing email</label><input id="cemail" type="email" /></div>
        <button class="primary" type="submit" style="align-self:flex-end">Add customer</button>
      </form>
      <table>
        <thead><tr><th>Name</th><th>Email</th><th></th></tr></thead>
        <tbody>${state.customers.map((c) => `<tr data-customer="${c.id}">
          <td>${c.name}</td><td class="sub" style="margin:0">${c.email}</td>
          <td style="text-align:right"><button class="danger" data-del="${c.id}">Delete</button></td></tr>`).join('')}</tbody>
      </table>
    </div>`);
  wireChrome();
  $('#add-customer').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!$('#cname').value.trim()) return;
    await api('/api/customers', { method: 'POST', body: JSON.stringify({ name: $('#cname').value, email: $('#cemail').value }) });
    await loadCustomers(); render();
  });
  root.querySelectorAll('[data-del]').forEach((btn) => btn.addEventListener('click', async () => {
    // Intentional confirmation step (honeypot HP-1) — this is correct behaviour.
    if (!confirm('Delete this customer? Their invoices stay on the account.')) return;
    await api(`/api/customers/${btn.dataset.del}`, { method: 'DELETE' });
    await loadCustomers(); render();
  }));
}

function wireChrome() {
  root.querySelectorAll('[data-nav]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); go(a.getAttribute('href')); }));
  $('#logout')?.addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); state.user = null; go('/login'); });
}

// --------------------------------------------------------------------- loader
async function loadInvoices() {
  state.invoices = null; render();
  const qs = new URLSearchParams({ page: String(state.page) });
  if (state.search) qs.set('search', state.search);
  if (state.status && state.status !== 'all') qs.set('status', state.status);
  state.invoices = await api(`/api/invoices?${qs}`);
  render();
}
async function loadCustomers() {
  state.customers = (await api('/api/customers')).customers;
}

async function boot() {
  try { state.user = await api('/api/me'); } catch { state.user = null; }
}

function render() {
  if (!state.user) return loginScreen();
  if (state.route === '/customers') return customersScreen();
  return invoicesScreen();
}

(async function start() {
  const health = await fetch('/api/test/health').then((r) => r.json()).catch(() => ({ activeBugs: [] }));
  BUGS = new Set(health.activeBugs || []);
  document.documentElement.className = [...BUGS].map((b) => b.toLowerCase()).join(' ');
  await boot();
  if (!state.user) { render(); return; }
  await loadCustomers();
  if (state.route === '/customers') render(); else await loadInvoices();
})();
