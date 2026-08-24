#!/usr/bin/env node

/**
 * Install the Gyredeck Claude Code hook.
 *
 * Copies the hook adapter to a stable local path and merges the required hook
 * entries into ~/.claude/settings.json without clobbering existing hooks. It
 * only adds entries whose command is not already present, so re-running is safe.
 *
 *   node scripts/install-claude-hooks.mjs           # user scope (~/.claude)
 *   node scripts/install-claude-hooks.mjs --project # project scope (.claude)
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_HOOK = join(HERE, "..", "adapters", "claude", "gyredeck-claude-hook.mjs");
const CONFIG_DIR = join(homedir(), ".config", "gyredeck");
const INSTALLED_HOOK = join(CONFIG_DIR, "gyredeck-claude-hook.mjs");

// PreToolUse/PostToolUse take a tool matcher; the rest are event-only.
const MATCHED_EVENTS = ["PreToolUse", "PostToolUse"];
const PLAIN_EVENTS = ["UserPromptSubmit", "Notification", "Stop", "SubagentStop", "SessionStart", "SessionEnd", "PreCompact"];

const projectScope = process.argv.includes("--project");
const settingsPath = projectScope
  ? join(process.cwd(), ".claude", "settings.json")
  : join(homedir(), ".claude", "settings.json");

const command = (event) => `node ${INSTALLED_HOOK} --event ${event}`;

const readSettings = () => {
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    throw new Error(`Refusing to overwrite unparsable settings at ${settingsPath}`);
  }
};

const hasCommand = (entries, cmd) =>
  Array.isArray(entries) &&
  entries.some((entry) => Array.isArray(entry.hooks) && entry.hooks.some((h) => h.command === cmd));

const install = () => {
  mkdirSync(CONFIG_DIR, { recursive: true });
  copyFileSync(SOURCE_HOOK, INSTALLED_HOOK);

  const settings = readSettings();
  settings.hooks ??= {};
  let added = 0;

  const addEntry = (event, entry) => {
    settings.hooks[event] ??= [];
    if (hasCommand(settings.hooks[event], command(event))) return;
    settings.hooks[event].push(entry);
    added += 1;
  };

  for (const event of MATCHED_EVENTS) {
    addEntry(event, { matcher: "*", hooks: [{ type: "command", command: command(event) }] });
  }
  for (const event of PLAIN_EVENTS) {
    addEntry(event, { hooks: [{ type: "command", command: command(event) }] });
  }

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  console.log(`✓ Hook installed: ${INSTALLED_HOOK}`);
  console.log(`✓ Settings updated: ${settingsPath} (${added} hook entr${added === 1 ? "y" : "ies"} added)`);
  console.log("  Restart Claude Code (or start a new session) to load the hooks.");
};

install();
