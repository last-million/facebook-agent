const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const EDGE_PATHS = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

function projectPath(relativePath) {
  const resolved = path.resolve(ROOT, String(relativePath || '').replace(/[\\/]+/g, path.sep));
  const rel = path.relative(ROOT, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`path outside project: ${relativePath}`);
  return resolved;
}

function localBrowserExecutablePath() {
  const found = EDGE_PATHS.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('Microsoft Edge executable was not found for image migration.');
  return found;
}

function webpRefs(text) {
  const refs = new Set();
  const pattern = /data[\\/]+product-assets[\\/][^|\r\n"']+?\.webp/gi;
  for (const match of String(text || '').matchAll(pattern)) {
    refs.add(match[0].replace(/\\/g, '/'));
  }
  return [...refs];
}

async function convertWebpToJpg(page, sourceRelative) {
  const sourcePath = projectPath(sourceRelative);
  const targetRelative = sourceRelative.replace(/\.webp$/i, '.jpg');
  const targetPath = projectPath(targetRelative);
  if (!fs.existsSync(sourcePath)) return { sourceRelative, targetRelative, converted: false, reason: 'source_missing' };
  if (fs.existsSync(targetPath)) return { sourceRelative, targetRelative, converted: false, reason: 'target_exists' };
  const buffer = fs.readFileSync(sourcePath);
  const converted = await page.evaluate(async ({ dataUrl }) => {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = dataUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    return {
      dataUrl: canvas.toDataURL('image/jpeg', 0.92),
      width: canvas.width,
      height: canvas.height,
    };
  }, { dataUrl: `data:image/webp;base64,${buffer.toString('base64')}` });
  const match = String(converted.dataUrl || '').match(/^data:image\/jpeg;base64,(.+)$/);
  if (!match) throw new Error(`JPEG conversion failed for ${sourceRelative}`);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, Buffer.from(match[1], 'base64'));
  return { sourceRelative, targetRelative, converted: true, width: converted.width, height: converted.height };
}

function rewriteText(text, replacements) {
  let next = String(text || '');
  for (const [from, to] of replacements) {
    next = next.split(from).join(to);
  }
  return next
    .replace(/selected_webp_ready_pending_human_approval/g, 'selected_image_ready_pending_human_approval')
    .replace(/selected_webp_approved/g, 'selected_image_approved')
    .replace(/selected_webp=/g, 'selected_images=')
    .replace(/original_local_webp=/g, 'original_local_image=')
    .replace(/base_review_webp_hd_failed/g, 'base_review_jpg_hd_failed')
    .replace(/chatgpt_hd_download/g, 'chatgpt_hd_jpg_converted');
}

(async () => {
  const targets = [
    path.join(DATA_DIR, 'workflow-state.json'),
    path.join(DATA_DIR, 'product-review-images.txt'),
    path.join(DATA_DIR, 'posting-plan.jsonl'),
    path.join(DATA_DIR, 'pending-approvals.txt'),
  ].filter((file) => fs.existsSync(file));

  const texts = new Map(targets.map((file) => [file, fs.readFileSync(file, 'utf8')]));
  const refs = [...new Set([...texts.values()].flatMap(webpRefs))];
  const browser = await chromium.launch({
    executablePath: localBrowserExecutablePath(),
    headless: true,
    args: ['--disable-popup-blocking'],
  });
  const converted = [];
  const replacements = [];
  try {
    const page = await browser.newPage();
    for (const ref of refs) {
      const result = await convertWebpToJpg(page, ref);
      converted.push(result);
      if (result.reason !== 'source_missing') replacements.push([ref, result.targetRelative]);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const rewritten = [];
  for (const [file, text] of texts) {
    const next = rewriteText(text, replacements);
    if (next !== text) {
      fs.writeFileSync(file, next);
      rewritten.push(path.relative(ROOT, file).replace(/\\/g, '/'));
    }
  }

  console.log(JSON.stringify({ ok: true, refs: refs.length, converted, rewritten }, null, 2));
})().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message || String(err) }));
  process.exit(1);
});
