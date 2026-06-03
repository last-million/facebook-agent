// FB-Prod-1h-Autostop — hard stop for the operator's 1-hour prod test.
// Triggered by a one-time Windows Scheduled Task (runs as SYSTEM) at launch+60min.
// DISARMS the autopilot (enabled=false + armed=false) and RESTORES the normal
// posting window (18:00-23:00 ET). Lossless Node GET->edit->PUT (never PS ConvertTo-Json).
// Self-contained: reads the dashboard token from disk, logs to data/prod-1h-test.log.
const http = require("http");
const fs = require("fs");
const path = require("path");
const PROJ = "C:\\Users\\Administrator\\Desktop\\facbeook agent";
const LOG = path.join(PROJ, "data", "prod-1h-test.log");
function log(line) { try { fs.appendFileSync(LOG, new Date().toISOString() + "\t" + line + "\n"); } catch (_) {} console.log(line); }
let TOKEN = "";
try { TOKEN = fs.readFileSync(path.join(PROJ, "data", ".dashboard-token"), "utf8").trim(); }
catch (e) { log("prod_1h_autostop_ERROR\ttoken_read_failed\t" + e.message); process.exit(1); }
function req(method, p, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = bodyObj ? Buffer.from(JSON.stringify(bodyObj)) : null;
    const r = http.request({ host: "127.0.0.1", port: 9317, path: p, method, headers: Object.assign(
      { "x-dashboard-token": TOKEN }, data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}) },
      (res) => { let s = ""; res.on("data", (d) => (s += d)); res.on("end", () => resolve({ status: res.statusCode, body: s })); });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}
(async () => {
  const g = await req("GET", "/api/state");
  const j = JSON.parse(g.body.replace(/^﻿/, ""));
  const state = j.state || j;
  state.operator = state.operator || {};
  state.operator.autopilotEnabled = false;
  state.operator.armedForExternalActions = false;
  state.rules = state.rules || {};
  state.rules.peakStartTime = "18:00";
  state.rules.peakStopTime = "23:00";
  const p = await req("PUT", "/api/state", { state });
  const after = JSON.parse(p.body.replace(/^﻿/, "")).state;
  log("prod_1h_autostop\tput=" + p.status +
    "\tenabled=" + after.operator.autopilotEnabled +
    "\tarmed=" + after.operator.armedForExternalActions +
    "\tdryRun=" + after.operator.autopilotDryRun +
    "\tpeak=" + after.rules.peakStartTime + "-" + after.rules.peakStopTime +
    "\tpostsThisRun=" + after.operator.autopilotPostsThisRun);
})().catch((e) => { log("prod_1h_autostop_ERROR\t" + (e.message || String(e))); process.exit(1); });
