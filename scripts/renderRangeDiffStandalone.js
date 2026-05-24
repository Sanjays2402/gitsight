#!/usr/bin/env node
// Standalone renderer for the split-diff range viewer screenshot.
const fs = require('fs');
const out = process.argv[2] || 'screenshots/range-diff.html';
const esc = s => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const files = [
  { path: 'src/auth/oauth.ts', additions: 47, deletions: 12 },
  { path: 'src/auth/middleware.ts', additions: 23, deletions: 8 },
  { path: 'src/payments/stripe.ts', additions: 156, deletions: 22 },
  { path: 'src/payments/webhook.ts', additions: 89, deletions: 4 },
  { path: 'src/models/User.ts', additions: 12, deletions: 3 },
  { path: 'src/models/Subscription.ts', additions: 78, deletions: 0 },
  { path: 'tests/auth.test.ts', additions: 134, deletions: 18 },
  { path: 'tests/payments.test.ts', additions: 201, deletions: 12 },
  { path: 'package.json', additions: 4, deletions: 2 },
  { path: 'README.md', additions: 18, deletions: 5 },
];
const totalAdd = files.reduce((a,f)=>a+f.additions,0);
const totalDel = files.reduce((a,f)=>a+f.deletions,0);
const tree = files.map((f,i)=>`<div class="tree-item"><span class="tree-path">${esc(f.path)}</span><span class="tree-stat"><span class="add">+${f.additions}</span> <span class="del">−${f.deletions}</span></span></div>`).join('');

// Detailed diff for stripe.ts
const rows = [];
rows.push(`<tr class="hunk-head"><td colspan="4">@@ -118,8 +118,14 @@ export class StripeService {</td></tr>`);
const pairs = [
  ['c', 118, 124, '  async createCharge(amount: number, customerId: string) {'],
  ['c', 119, 125, '    const idempotencyKey = randomUUID();'],
  ['d', 120, null, '    return this.stripe.charges.create({'],
  ['d', 121, null, '      amount, currency: "usd", customer: customerId,'],
  ['d', 122, null, '    }, { idempotencyKey });'],
  ['a', null, 126, '    return this.stripe.charges.create({'],
  ['a', null, 127, '      amount,'],
  ['a', null, 128, '      currency: "usd",'],
  ['a', null, 129, '      customer: customerId,'],
  ['a', null, 130, '      metadata: { source: "gitsight", retryable: "true" },'],
  ['a', null, 131, '    }, {'],
  ['a', null, 132, '      idempotencyKey,'],
  ['a', null, 133, '      maxNetworkRetries: 3,'],
  ['a', null, 134, '    });'],
  ['c', 123, 135, '  }'],
  ['c', 124, 136, ''],
];
for (const [t, l, r, txt] of pairs) {
  const lc = t==='d'?'d':t==='c'?'c':'e', rc = t==='a'?'a':t==='c'?'c':'e';
  const lt = (t==='d'||t==='c') ? esc(txt) : '';
  const rt = (t==='a'||t==='c') ? esc(txt) : '';
  rows.push(`<tr><td class="ln">${l ?? ''}</td><td class="src ${lc}">${lt}</td><td class="ln">${r ?? ''}</td><td class="src ${rc}">${rt}</td></tr>`);
}
rows.push(`<tr class="hunk-head"><td colspan="4">@@ -201,6 +207,12 @@ export class StripeService {</td></tr>`);
const pairs2 = [
  ['c', 201, 207, '  async refundCharge(chargeId: string, amount?: number) {'],
  ['a', null, 208, '    const charge = await this.stripe.charges.retrieve(chargeId);'],
  ['a', null, 209, '    if (charge.refunded) {'],
  ['a', null, 210, '      throw new AlreadyRefundedError(chargeId);'],
  ['a', null, 211, '    }'],
  ['a', null, 212, ''],
  ['c', 202, 213, '    return this.stripe.refunds.create({ charge: chargeId, amount });'],
  ['c', 203, 214, '  }'],
];
for (const [t, l, r, txt] of pairs2) {
  const lc = t==='d'?'d':t==='c'?'c':'e', rc = t==='a'?'a':t==='c'?'c':'e';
  const lt = (t==='d'||t==='c') ? esc(txt) : '';
  const rt = (t==='a'||t==='c') ? esc(txt) : '';
  rows.push(`<tr><td class="ln">${l ?? ''}</td><td class="src ${lc}">${lt}</td><td class="ln">${r ?? ''}</td><td class="src ${rc}">${rt}</td></tr>`);
}

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin:0; font:13px -apple-system,system-ui,sans-serif; color:#cccccc; background:#1e1e1e; display:flex; height:100vh; }
  .sidebar { width:300px; flex-shrink:0; background:#181818; border-right:1px solid #2b2b2b; overflow-y:auto; }
  .sb-head { padding:12px 14px; border-bottom:1px solid #2b2b2b; font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:#9d9d9d; background:#252526; }
  .sb-meta { padding:8px 14px; font-size:11px; color:#9d9d9d; border-bottom:1px solid #2b2b2b; }
  .tree-item { padding:6px 14px; display:flex; justify-content:space-between; gap:8px; font-size:12px; }
  .tree-item:hover { background:#2a2d2e; }
  .tree-path { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:"SF Mono",Menlo,monospace; }
  .tree-stat { font-family:"SF Mono",Menlo,monospace; font-size:11px; flex-shrink:0; }
  .add { color:#4ade80; } .del { color:#f87171; }
  .main { flex:1; overflow:auto; padding:20px 28px; }
  .header { padding-bottom:14px; border-bottom:1px solid #2b2b2b; margin-bottom:16px; }
  .header h1 { margin:0 0 8px; font-size:18px; font-weight:600; color:#fff; }
  .header .ref { font-family:"SF Mono",Menlo,monospace; background:#0e639c33; color:#7dd3fc; padding:3px 10px; border-radius:12px; font-size:11px; }
  .header .sum { color:#9d9d9d; font-size:12px; margin-top:8px; }
  .file { margin-bottom:24px; border:1px solid #2b2b2b; border-radius:6px; overflow:hidden; }
  .file-head { padding:10px 14px; background:#252526; display:flex; justify-content:space-between; font-family:"SF Mono",Menlo,monospace; font-size:12px; border-bottom:1px solid #2b2b2b; }
  .fp { color:#7dd3fc; font-weight:600; }
  table.diff { width:100%; border-collapse:collapse; font-family:"SF Mono",Menlo,monospace; font-size:12px; }
  table.diff td { padding:2px 10px; vertical-align:top; white-space:pre; }
  td.ln { width:50px; color:#666; text-align:right; user-select:none; background:#1a1a1a; border-right:1px solid #2b2b2b; }
  td.src.d { background:#ef444422; color:#fca5a5; }
  td.src.a { background:#10b98122; color:#86efac; }
  td.src.e { background:#3a3a3a44; }
  td.src.c { color:#cccccc; }
  tr.hunk-head td { background:#0e639c22; color:#7dd3fc; padding:8px 14px; font-style:italic; font-size:11px; }
</style></head><body>
  <aside class="sidebar">
    <div class="sb-head">Changed Files (${files.length})</div>
    <div class="sb-meta"><span class="add">+${totalAdd}</span> additions · <span class="del">−${totalDel}</span> deletions</div>
    ${tree}
  </aside>
  <main class="main">
    <div class="header">
      <h1>Comparing changes</h1>
      <div><span class="ref">main</span> → <span class="ref">feature/stripe-retry</span></div>
      <div class="sum">10 files changed · <span class="add">+${totalAdd} additions</span> · <span class="del">−${totalDel} deletions</span> · 7 commits</div>
    </div>
    <section class="file">
      <header class="file-head"><span class="fp">src/payments/stripe.ts</span><span><span class="add">+156</span> <span class="del">−22</span></span></header>
      <table class="diff"><tbody>${rows.join('')}</tbody></table>
    </section>
  </main>
</body></html>`;
fs.writeFileSync(out, html);
console.log(out);
