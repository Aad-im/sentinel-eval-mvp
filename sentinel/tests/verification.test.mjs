// Exercises the whole non-LLM pipeline with hand-written probes standing in for
// agent output: a real bug, a honeypot (intended behaviour), and a bogus claim.
import { chromium } from 'playwright';
import { AppHarness, REPO_ROOT } from '../src/harness.js';
import { RunEvidence } from '../src/evidence.js';
import { dedupe, verifyFinding, attribute, SUPPRESSED } from '../src/verify.js';
import { score } from '../src/scoring.js';
import path from 'node:path';

const target = new AppHarness({ port: 4510, bugs: 'all', label: 'target' });
const control = new AppHarness({ port: 4511, bugs: 'none', label: 'control' });
await Promise.all([target.start(), control.start()]);
const seed = await target.seed(); await control.seed();
console.log('seeded. foreign invoice:', seed.fixtures.foreignInvoiceId);
console.log('otp login:', (await target.loginApi('primary')).email);

const claims = [
  { dimension:'auth-access', model:'test', severity:'critical', title:'Cross-tenant invoice read',
    summary:'s', expected:'404', actual:'200', userImpact:'i', agentConfidence:0.9,
    probe:{ steps:[{op:'seed'},{op:'api',method:'GET',path:`/api/invoices/${seed.fixtures.foreignInvoiceId}`,as:'primary'}],
            assert:{kind:'httpStatus',equals:200} } },
  { dimension:'core-flows', model:'test', severity:'high', title:'Tax computed on unit price',
    summary:'s', expected:'80', actual:'20', userImpact:'i', agentConfidence:0.85,
    probe:{ steps:[{op:'seed'},{op:'api',method:'POST',path:'/api/invoices',as:'primary',
              body:{customerId:seed.fixtures.primaryCustomerWithInvoices,description:'probe',qty:4,unitPrice:100,taxRate:0.2}}],
            assert:{kind:'jsonNumber',path:'tax',notEquals:80} } },
  { dimension:'perf-visual', model:'test', severity:'medium', title:'Search exceeds 2s budget',
    summary:'s', expected:'<2000ms', actual:'2188ms', userImpact:'i', agentConfidence:0.8,
    probe:{ steps:[{op:'seed'},{op:'api',method:'GET',path:'/api/invoices?search=milestone',as:'primary'}],
            assert:{kind:'responseTimeMs',greaterThan:2000} } },
  // HONEYPOT: an empty org legitimately shows an empty table. Fires on both builds.
  { dimension:'data-integrity', model:'test', severity:'high', title:'Invoice list renders no rows',
    summary:'s', expected:'rows', actual:'none', userImpact:'i', agentConfidence:0.7,
    probe:{ steps:[{op:'seed',scenario:'empty-org'},{op:'login',as:'primary'},{op:'goto',path:'/app'},{op:'wait',ms:600}],
            assert:{kind:'elementCount',selector:'tbody tr[data-invoice]',equals:0} } },
  // BOGUS: asserts something simply untrue.
  { dimension:'accessibility', model:'test', severity:'medium', title:'Search box has no accessible name',
    summary:'s', expected:'label', actual:'none', userImpact:'i', agentConfidence:0.6,
    probe:{ steps:[{op:'seed'},{op:'login',as:'primary'},{op:'goto',path:'/app'},{op:'wait',ms:600}],
            assert:{kind:'missingAccessibleName',selector:'#search'} } },
];

const browser = await chromium.launch({ headless: true });
const evidence = new RunEvidence(path.join(REPO_ROOT,'runs'), 'smoke');
const deduped = dedupe(claims.map((c,i)=>({...c, localId:`c${i}`})));
const verified = [];
for (const [i,f] of deduped.entries()) {
  const v = await verifyFinding(f, { target, control, browser, evidence, index: i+1 });
  v.attributedBug = SUPPRESSED.has(v.verdict) ? null : await attribute(v, { target, browser, bugIds: seed.activeBugs });
  console.log(`  [${v.verdict}] conf=${v.confidence} obs=${JSON.stringify(v.observed)?.slice(0,40)} → ${v.attributedBug ?? '—'}  ${v.title}`);
  verified.push(v);
}
console.log(JSON.stringify(score({raw:claims,deduped,verified,activeBugs:seed.activeBugs,honeypots:{}}), null, 2));
await browser.close(); await target.stop(); await control.stop();
