#!/usr/bin/env node

/**
 * Switch the active gh account AND sync the global git commit identity to match it.
 * `gh auth switch` only changes which token gh uses; it does not touch git's
 * user.name/user.email, so commits would keep the old author. This wrapper fixes
 * that. Writes --global so every repo without its own local override follows the
 * active account.
 *
 * Usage:
 *   node scripts/gh-switch.mjs <github-login>   # switch to that account, then sync
 *   node scripts/gh-switch.mjs                  # just sync git identity to the current account
 *
 * Email: uses the account's email when gh exposes it, otherwise the GitHub
 * noreply address (<id>+<login>@users.noreply.github.com) so commits still
 * attribute to the right account without leaking a private email.
 */

import { execFileSync } from "node:child_process";

const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const targetUser = process.argv[2];

try {
  if (targetUser) {
    run("gh", ["auth", "switch", "--user", targetUser]);
    console.log(`Switched gh account to ${targetUser}`);
  }

  const account = JSON.parse(run("gh", ["api", "user", "--jq", "{login, id, name, email}"]));
  const name = account.login;
  const email =
    account.email && account.email.length > 0
      ? account.email
      : `${account.id}+${account.login}@users.noreply.github.com`;

  run("git", ["config", "--global", "user.name", name]);
  run("git", ["config", "--global", "user.email", email]);

  console.log(`Global git identity → ${name} <${email}>`);
} catch (error) {
  const message = error.stderr?.toString().trim() || error.message;
  console.error(`gh-switch failed: ${message}`);
  process.exit(1);
}
