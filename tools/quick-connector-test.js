#!/usr/bin/env node
// Quick connector test that skips asset prep / discovery / SYL / shortlink.
// Reuses the latest posting-plan row to test ONLY the live-publish step
// (the part that runs the modified fb-post-test-capture-url.js).
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const TOKEN = fs.readFileSync(path.join(DATA, '.dashboard-token'), 'utf8').trim();
const PLAN_FILE = path.join(DATA, 'posting-plan.jsonl');

const lines = fs.readFileSync(PLAN_FILE, 'utf8').split('\n').filter(Boolean);
let plan = null;
for (let i = lines.length - 1; i >= 0; i -= 1) {
  try {
    const row = JSON.parse(lines[i]);
    if (row.runType === 'one_post_test' && row.planId && row.sequence) {
      plan = row;
      break;
    }
  } catch {}
}
if (!plan) {
  console.error('No usable one_post_test plan row found.');
  process.exit(2);
}
console.log(JSON.stringify({ type: 'using_plan', planId: plan.planId, sequence: plan.sequence, profile: plan.profile, groupUrl: plan.groupUrl }));

const startedAt = Date.now();
async function main() {
  const res = await fetch('http://127.0.0.1:9317/api/posting/run-live-test-post', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dashboard-token': TOKEN },
    body: JSON.stringify({
      planId: plan.planId,
      sequence: plan.sequence,
      operatorApprovedLive: true,
      liveConfirmation: 'PUBLISH TEST',
    }),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 600) }; }
  const elapsedMs = Date.now() - startedAt;
  console.log(JSON.stringify({
    type: 'live_publish_done',
    elapsedMs,
    elapsedSec: Math.round(elapsedMs / 100) / 10,
    httpStatus: res.status,
    ok: body?.ok,
    posted: body?.posted,
    postUrl: body?.postUrl,
    message: body?.message,
  }));
}
main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
