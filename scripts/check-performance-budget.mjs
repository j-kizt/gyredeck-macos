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
 *
 * The total one was added on 2026-10-26 (#233). The ceiling above reads the largest chunk
 * only, so moving code into a lazy chunk passes it while the app ships just as much: React
 * 19.3 could have been paid for by splitting rather than by trimming. 115,075 is main's
 * total that day, 114,874, plus the 201 bytes of headroom the largest-chunk ceiling had
 * over main's 111,799 at the same moment, so the two leave the same room.
 *
 * Both were raised on 2026-10-26 (#256), by the user's decision to take React 19.3, which
 * adds about 8.6 kB. #233's trims cut 6.2 kB and fell 2.2 kB short, and nothing else could
 * be trimmed without changing behaviour. 116,000 and 119,000 are sized to cover main plus
 * v1.25.0 (#245/#244, about 1.1 kB more, not yet merged) plus React 19.3, with roughly the
 * headroom the ceilings had before. They still stop a library arriving.
 *
 * Raised again on 2026-10-27 (#199), by the owner's decision to measure the Discord settings
 * and room icon first and then raise by what they used: main was 115,901 / 118,978, the card
 * measured 117,927 / 121,006 (+2.0 kB each). 118,100 and 121,200 keep about the same
 * headroom as before.
 *
 * And again on 2026-10-27 (#199 audit r5), the same way: the rows that show a room the
 * Discord member could not leave, what waits for Discord and what Remove could not send
 * measured 118,137 / 121,213 (+210 / +207 bytes on 117,927 / 121,006). 118,310 and 121,407
 * keep the 173 / 194 bytes of headroom the last raise left.
 *
 * And again on 2026-11-02 (#277), the same way: Release notes rendered as headings, bullets,
 * bold and code (a few lines of our own, no library) measured 118,522 / 121,598 on main's
 * 118,169 / 121,247 (+353 / +351). 118,663 and 121,758 keep the headroom main had.
 *
 * And on 2026-11-02 (#280), by the owner's decision, the same way: the session registry moved
 * to a file (load, migration, ordered saves, retried saves and re-reads, pruning of old data,
 * a notice when history is not being saved) measured 119,546 / 122,624 on main's 118,565 /
 * 121,641 (+981 / +983, after its audit rounds). 119,644 and 122,741 keep main's 98 / 117.
 *
 * And on 2026-11-03 (#288), by the owner's decision ("A", from Discord): the rows saying macOS
 * refused the saved token or owner measured 119,692 / 122,769 on main's 119,546 / 122,624
 * (+146 / +145). 119,790 and 122,886 keep main's 98 / 117.
 * And on 2026-11-02 (#205), by the owner's decision ("A": raise it by what is used): Disconnect
 * all in Settings, with the rooms it could not disconnect and a retry, measured 120,033 /
 * 123,109 on main's 119,692 / 122,769 after #288 (+341 / +340). 120,131 and 123,226 keep
 * main's 98 / 117.
 *
 * #211/#278 (the keep-awake row reading Rust's answer on a beat: one numbered call in flight,
 * given up on after 3 s, at most two left unanswered, a page number from Rust) measured 119,910 / 122,985 on main's
 * 119,692 / 122,769 before #205, and 120,257 / 123,337 on main's 120,033 / 123,109 after it;
 * 120,355 and 123,454 keep main's 98 / 117.
 * Raised by the owner's decision, "A" at the terminal on 2026-11-03.
 *
 * Dependabot #367 (@types/node, discord.js, lucide-react, @vitejs/plugin-react) measured
 * 120,368 on main's 120,353 (+15); 120,370 keeps main's 2. Raised by the owner at the
 * terminal on 2026-11-08 ("raise the ceiling").
 */
const BUDGETS = {
  coreDistBytes: 575_500,
  cssGzipBytes: 13_650,
  jsGzipBytes: 120_370,
  jsTotalGzipBytes: 123_454,
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
const jsTotalGzipBytes = assets
  .filter((asset) => asset.name.endsWith(".js"))
  .reduce((sum, asset) => sum + asset.gzipBytes, 0);

const dist = await walk(distRoot);
const coreDistBytes = dist.bytes;

const payload = {
  budgets: BUDGETS,
  current: {
    cssGzipBytes: css.gzipBytes,
    coreDistBytes,
    distFiles: dist.files,
    jsGzipBytes: js.gzipBytes,
    jsTotalGzipBytes,
  },
};

console.log(JSON.stringify(payload, null, 2));

if (css.gzipBytes > BUDGETS.cssGzipBytes) throw new Error(`CSS gzip budget exceeded: ${css.gzipBytes} > ${BUDGETS.cssGzipBytes}`);
if (js.gzipBytes > BUDGETS.jsGzipBytes) throw new Error(`JavaScript gzip budget exceeded: ${js.gzipBytes} > ${BUDGETS.jsGzipBytes}`);
if (jsTotalGzipBytes > BUDGETS.jsTotalGzipBytes) throw new Error(`JavaScript total gzip budget exceeded: ${jsTotalGzipBytes} > ${BUDGETS.jsTotalGzipBytes}`);
if (coreDistBytes > BUDGETS.coreDistBytes) throw new Error(`desktop core dist budget exceeded: ${coreDistBytes} > ${BUDGETS.coreDistBytes}`);
