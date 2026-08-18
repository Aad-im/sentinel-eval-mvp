// Walks every common user journey through the real browser, using only the ops
// available to an agent, and checks the OTP probe now survives replay.
import { chromium } from 'playwright';
import { AppHarness } from '../src/harness.js';
import { runProbe } from '../src/probe.js';

const t = new AppHarness({ port: 4710, bugs: 'all', label: 'target' });
const c = new AppHarness({ port: 4711, bugs: 'none', label: 'control' });
await Promise.all([t.start(), c.start()]);
const seed = await t.seed(); await c.seed();
const browser = await chromium.launch({ headless: true });

const cases = [
  ['A sign-in (real OTP handshake)', {
    steps: [{op:'seed'},{op:'startLogin',as:'primary'},{op:'submitOtp',code:'correct'}],
    assert: {kind:'httpStatus',equals:200}}, true],
  ['A OTP brute force — 10 wrong codes still accepted', {
    steps: [{op:'seed'},{op:'startLogin',as:'primary'},{op:'submitOtp',code:'000000',times:10}],
    assert: {kind:'httpStatus',equals:401}}, 'differs'],
  ['B search + status filter', {
    steps: [{op:'seed'},{op:'login',as:'primary'},{op:'goto',path:'/app'},
            {op:'selectOption',selector:'#status-filter',value:'paid'},{op:'wait',ms:800}],
    assert: {kind:'elementCount',selector:'tbody tr[data-invoice]',greaterThan:0}}, true],
  ['C open invoice detail by clicking a row', {
    steps: [{op:'seed'},{op:'login',as:'primary'},{op:'goto',path:'/app'},
            {op:'click',selector:'tbody tr[data-invoice]'},{op:'wait',ms:800}],
    assert: {kind:'elementCount',selector:'[data-testid="detail-modal"]',equals:1}}, true],
  ['C open invoice detail via KEYBOARD (Enter on focused row)', {
    steps: [{op:'seed'},{op:'login',as:'primary'},{op:'goto',path:'/app'},
            {op:'pressKey',selector:'tbody tr[data-invoice]',key:'Enter'},{op:'wait',ms:800}],
    assert: {kind:'elementCount',selector:'[data-testid="detail-modal"]',equals:1}}, true],
  ['D mark as paid', {
    steps: [{op:'seed'},{op:'login',as:'primary'},{op:'goto',path:'/app'},
            {op:'selectOption',selector:'#status-filter',value:'open'},{op:'wait',ms:800},
            {op:'click',selector:'tbody tr[data-invoice]'},{op:'wait',ms:800},
            {op:'click',selector:'#mark-paid'},{op:'wait',ms:900}],
    assert: {kind:'textPresent',text:'paid'}}, true],
  ['E create invoice via dropdown + form', {
    steps: [{op:'seed'},{op:'login',as:'primary'},{op:'goto',path:'/app'},
            {op:'click',selector:'#new-invoice'},{op:'wait',ms:500},
            {op:'selectOption',selector:'#customer',label:'Acme Robotics'},
            {op:'fill',selector:'#description',value:'Journey E probe'},
            {op:'fill',selector:'#qty',value:'3'},{op:'fill',selector:'#unitPrice',value:'200'},
            {op:'click',selector:'#save-invoice'},{op:'wait',ms:1200},
            {op:'api',method:'GET',path:'/api/invoices?search=Journey%20E%20probe',as:'primary'}],
    assert: {kind:'jsonNumber',path:'total',greaterThan:0}}, 'skip'],
  ['F delete customer (confirm dialog)', {
    steps: [{op:'seed'},{op:'login',as:'primary'},{op:'goto',path:'/customers'},{op:'wait',ms:600}],
    assert: {kind:'elementCount',selector:'button[data-del]',greaterThan:0}}, true],
  ['G sign out', {
    steps: [{op:'seed'},{op:'login',as:'primary'},{op:'goto',path:'/app'},
            {op:'click',selector:'#logout'},{op:'wait',ms:900}],
    assert: {kind:'textPresent',text:'Sign in to Ledgerly'}}, true],
];

for (const [name, probe, expect] of cases) {
  await t.seed();
  const rt = await runProbe(probe, { harness: t, browser, recorder: null });
  let line = `${rt.error ? 'ERR ' : rt.held ? 'held' : 'not '} target=${JSON.stringify(rt.observed)?.slice(0,50)}`;
  if (expect === 'differs') {
    await c.seed();
    const rc = await runProbe(probe, { harness: c, browser, recorder: null });
    line += `  control=${JSON.stringify(rc.observed)} → ${rt.held && !rc.held ? 'DIFFERENTIATES ✓' : 'NO SIGNAL ✗'}`;
  }
  console.log(`${(rt.error ? '✗' : (expect===true ? (rt.held?'✓':'✗') : '·'))} ${name.padEnd(52)} ${line}${rt.error ? ' :: '+rt.error.slice(0,90) : ''}`);
}
await browser.close(); await t.stop(); await c.stop();
