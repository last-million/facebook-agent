const fs = require("fs");
const lines = fs.readFileSync("data/events.log", "utf8").split(/\r?\n/).filter(Boolean);
const objs = lines.map(l => { try { return JSON.parse(l); } catch(e){ return null; } }).filter(Boolean);
const cutoff = Date.now() - 60*60*1000; // last hour
const recent = objs.filter(o => Date.parse(o.at) >= cutoff);
console.log("total lines:", lines.length, "recent(1h):", recent.length);
const wanted = new Set(["autopilot_publishing","autopilot_posting_concurrent","autopilot_worker_open_stagger","cpu_governor_waiting","cpu_governor_resumed","facebook_live_post_started","facebook_live_post_completed","adaptive_concurrency","autopilot_worker_skipped","machine_parallel_cap_synced"]);
const filtered = recent.filter(o => wanted.has(o.message));
fs.writeFileSync("tmp-recent-events.json", JSON.stringify(filtered, null, 1));
console.log("filtered count:", filtered.length);
