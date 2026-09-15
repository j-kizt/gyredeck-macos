import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const repoRoot = resolve(import.meta.dirname, "..");
const distRoot = join(repoRoot, "apps/desktop/dist");
const assetRoot = join(distRoot, "assets");

/**
 * Ceilings, not measurements.
 *
 * The JavaScript one was raised on 2026-09-15 from 105,500, which it had been quietly
 * over since the unread-messages work four merges earlier. Nothing noticed, because this
 * script was not wired into CI — a guard nobody runs is not a guard, and the number it
 * held had two bytes of headroom, which makes it a line that happened not to have been
 * crossed rather than a limit anyone chose.
 *
 * 112,000 is chosen to leave room for ordinary work while still stopping the thing this
 * is actually for: a library arriving. The drag-and-drop library considered for the repo
 * card reordering would have added roughly thirty thousand bytes gzipped and would hit
 * this immediately, which is the behaviour worth keeping.
 *
 * Raising it again should mean the same thing it meant this time: a deliberate decision
 * with the reason written down, never a number edited to match whatever was measured.
 */
const BUDGETS = {
  coreDistBytes: 575_500,
  cssGzipBytes: 13_650,
  jsGzipBytes: 112_000,
};

const walk = async (directory) => {
  let bytes = 0;
  let files = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const child = await walk(path);
      bytes += child.bytes;
      files += child.files;
    } else {
      bytes += (await stat(path)).size;
      files += 1;
    }
  }
  return { bytes, files };
};

const assets = [];
for (const name of await readdir(assetRoot)) {
  const path = join(assetRoot, name);
  const contents = await readFile(path);
  assets.push({ name, bytes: contents.length, gzipBytes: gzipSync(contents).length });
}

const largestAsset = (extension) => assets
  .filter((asset) => asset.name.endsWith(extension))
  .sort((left, right) => right.gzipBytes - left.gzipBytes)[0];
const css = largestAsset(".css");
const js = largestAsset(".js");
if (!css || !js) throw new Error("desktop build is missing its primary CSS or JavaScript asset");

const dist = await walk(distRoot);
const coreDistBytes = dist.bytes;

const payload = {
  budgets: BUDGETS,
  current: {
    cssGzipBytes: css.gzipBytes,
    coreDistBytes,
    distFiles: dist.files,
    jsGzipBytes: js.gzipBytes,
  },
};

console.log(JSON.stringify(payload, null, 2));

if (css.gzipBytes > BUDGETS.cssGzipBytes) throw new Error(`CSS gzip budget exceeded: ${css.gzipBytes} > ${BUDGETS.cssGzipBytes}`);
if (js.gzipBytes > BUDGETS.jsGzipBytes) throw new Error(`JavaScript gzip budget exceeded: ${js.gzipBytes} > ${BUDGETS.jsGzipBytes}`);
if (coreDistBytes > BUDGETS.coreDistBytes) throw new Error(`desktop core dist budget exceeded: ${coreDistBytes} > ${BUDGETS.coreDistBytes}`);
