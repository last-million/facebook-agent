// One-shot CPU profiler: boots server.js in-process, samples ~12s, prints hottest
// self-time functions so we can pinpoint the CPU spin. Self-exits. Safe to delete.
const inspector = require("inspector");
const fs = require("fs");
const path = require("path");
const session = new inspector.Session();
session.connect();

function topSelf(profile, n) {
  const nodes = profile.nodes || [];
  return nodes
    .filter((nd) => (nd.hitCount || 0) > 0)
    .map((nd) => ({
      h: nd.hitCount,
      fn: nd.callFrame.functionName || "(anonymous)",
      url: (nd.callFrame.url || "").replace(/^.*[\\/]/, ""),
      line: (nd.callFrame.lineNumber || 0) + 1,
    }))
    .sort((a, b) => b.h - a.h)
    .slice(0, n);
}

session.post("Profiler.enable", () => {
  session.post("Profiler.setSamplingInterval", { interval: 200 }, () => {
    session.post("Profiler.start", () => {
      try {
        require(path.join(__dirname, "server.js"));
        console.log("server.js required OK (listening)");
      } catch (e) {
        console.log("REQUIRE ERROR: " + (e && e.message));
      }
      setTimeout(() => {
        session.post("Profiler.stop", (err, res) => {
          if (err) {
            console.log("PROFILE ERR " + err.message);
            process.exit(1);
          }
          const profile = res.profile;
          try {
            fs.writeFileSync(path.join(__dirname, "data", "_spin.cpuprofile"), JSON.stringify(profile));
          } catch {}
          const top = topSelf(profile, 20);
          console.log("TOTAL SAMPLES: " + (profile.samples || []).length);
          console.log("TOP SELF-TIME (hitCount | fn | file:line):");
          for (const t of top) console.log(String(t.h).padStart(7) + "  " + t.fn + "  " + t.url + ":" + t.line);
          process.exit(0);
        });
      }, 12000);
    });
  });
});
