// Bundles the Discord connector and discord.js into ONE file the app ships as the resource
// gyredeck-discord.mjs. The output is built, not committed: it is ~1 MB of vendored
// discord.js that would bury every diff, and tauri.conf.json fails the build if it is
// missing, so a forgotten build cannot ship silently.
import { build } from "esbuild";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const outfile = join(root, "adapters/discord/dist/gyredeck-discord.mjs");

await build({
  entryPoints: [join(root, "adapters/discord/gyredeck-discord.mjs")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "eof",
  logLevel: "warning",
  // Optional native speed-ups that discord.js and ws probe for inside try/catch.
  external: ["zlib-sync", "bufferutil", "utf-8-validate", "@discordjs/voice"],
  // Bundled CommonJS calls require() for Node built-ins; ESM has none of its own.
  banner: { js: "import { createRequire as __gdCreateRequire } from 'node:module'; const require = __gdCreateRequire(import.meta.url);" },
});

console.log(`gyredeck-discord.mjs ${(statSync(outfile).size / 1024).toFixed(0)} KiB`);
