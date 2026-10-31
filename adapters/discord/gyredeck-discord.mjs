// Gyredeck's Discord connector: a child of the app, spoken to over stdin/stdout in
// newline-delimited JSON (protocol v1, see #199). It talks only to Discord, never to the
// bridge, and never holds a room password, the broker secret or the machine token. The bot
// token arrives on the first stdin line and nowhere else.
import { createInterface } from "node:readline";
import { createConnector, realClock } from "./connector.mjs";
import { createDiscordJs } from "./discord-js.mjs";

export function run({
  createDiscord = createDiscordJs,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  clock = realClock,
  guardProcess = true,
} = {}) {
  stdout.on?.("error", () => {});
  const connector = createConnector({
    discord: createDiscord(),
    clock,
    out: (line) => stdout.write(`${line}\n`),
  });

  if (guardProcess) {
    const die = (e) => {
      try {
        stderr.write(`${connector.redact(e?.stack ?? e)}\n`);
      } finally {
        process.exit(1);
      }
    };
    process.on("uncaughtException", die);
    process.on("unhandledRejection", die);
  }

  const lines = createInterface({ input: stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      msg = { t: "unparseable" };
    }
    connector.handle(msg);
  });
  const done = new Promise((resolve) => {
    lines.on("close", async () => {
      await connector.close();
      // Insurance only: a clean shutdown has already let the loop drain, and an unref'd
      // timer cannot itself keep the process alive.
      if (guardProcess) setTimeout(() => process.exit(0), 3000).unref();
      resolve();
    });
  });
  return { connector, done };
}

if (process.argv.includes("--parent-stdio")) run();
