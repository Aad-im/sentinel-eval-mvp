import { chromium } from 'playwright';
import { AppHarness } from '../src/harness.js';
import { runProbe } from '../src/probe.js';
const t = new AppHarness({ port: 4720, bugs: 'all' }); await t.start();
const seed = await t.seed();
const b = await chromium.launch({ headless: true });
// Delete a customer that has invoices, then look for orphan rows (BUG-003).
const r = await runProbe({ steps:[
  {op:'seed'},{op:'login',as:'primary'},{op:'goto',path:'/customers'},{op:'wait',ms:600},
  {op:'click',selector:`tr[data-customer="${seed.fixtures.primaryCustomerWithInvoices}"] button[data-del]`},
  {op:'wait',ms:900},{op:'goto',path:'/app'},{op:'wait',ms:1000}],
  assert:{kind:'consoleError',matches:"Cannot read properties of null"}}, {harness:t,browser:b,recorder:null});
console.log('dialogs seen:', JSON.stringify(r.dialogs));
console.log('BUG-003 console crash reproduced:', r.held, '|', (r.observed||[])[0]?.slice(0,80));
await b.close(); await t.stop();
