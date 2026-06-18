const fs = require('fs'), path = require('path');
const proj = __dirname;
const lines = fs.readFileSync(path.join(proj, 'data', 'harvested-products.jsonl'), 'utf8').split(/\r?\n/).filter(x => x.trim());
const m = new Map();
for (const l of lines) { try { const r = JSON.parse(l); if (r.firstCommentUrl) m.set(r.firstCommentUrl, r); } catch (e) {} }
const recs = [...m.values()]; const now = Date.now();
let postable = 0, imgGone = 0, fresh2d = 0, neverPosted = 0;
for (const r of recs) {
  let fp = r.imageLocalPath || ''; if (fp && !path.isAbsolute(fp)) fp = path.join(proj, fp);
  const ex = fp && fs.existsSync(fp);
  if (!ex || r.imageDeleted) imgGone++;
  const h = Date.parse(r.harvestedAt || ''); if (Number.isFinite(h) && (now - h) < 2 * 86400000) fresh2d++;
  if (!(r.lastPostedAt || r.posted)) neverPosted++;
  if (ex && r.firstCommentUrl && !r.imageDeleted && !(r.firstCommentUrl||'').startsWith('diag')) postable++;
}
console.log('unique=' + recs.length + ' postable=' + postable + ' imageGone=' + imgGone + ' fresh<2d=' + fresh2d + ' neverPosted=' + neverPosted);
