// Runs the connector entry (source or built bundle) as a real child process, with the fake
// Discord in place of discord.js. argv: <entry> [throw-token]
import { pathToFileURL } from "node:url";
import { createFakeDiscord } from "./fake.mjs";

const [entry, mode] = process.argv.slice(2);
const { run } = await import(pathToFileURL(entry).href);
run({
  createDiscord() {
    const fake = createFakeDiscord();
    if (mode === "throw-token") {
      fake.gate = async (op, args) => {
        if (op === "login") setImmediate(() => { throw new Error(`exploded holding ${args.token}`); });
      };
    }
    return fake;
  },
});
