import { expect, test } from "@playwright/test";

test("Usage keeps Codex values visible and labels them outdated after a refresh failure", async ({ page }) => {
  await page.addInitScript(() => {
    let codexCalls = 0;
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "set_keep_awake") return false;
        if (command === "codex_usage") {
          codexCalls += 1;
          if (codexCalls > 1) throw new Error("Codex usage is rate limited. Try again shortly.");
          return {
            providerId: "codex",
            displayName: "Codex",
            plan: "Pro 20x",
            fetchedAt: "2026-07-25T12:00:00Z",
            lines: [
              { type: "progress", label: "Session", used: 42, limit: 100, resetsAt: "2026-07-25T14:00:00Z" },
              { type: "progress", label: "Weekly", used: 11, limit: 100, resetsAt: "2026-07-30T12:00:00Z" },
              { type: "text", label: "Rate Limit Resets", value: "1 available" },
              { type: "text", label: "Credits", value: "$0.40 · 10 credits" },
              { type: "text", label: "Today", value: "1.2M tokens" },
              { type: "text", label: "Yesterday", value: "840K tokens" },
              { type: "text", label: "Latest Token Log", value: "7/25" },
              { type: "text", label: "Last 30 Days", value: "12.4M tokens" },
              { type: "text", label: "Daily 7/24", value: "960K tokens" },
              { type: "text", label: "gpt-5.1-codex", value: "62%" },
              { type: "text", label: "gpt-5.1", value: "28%" },
              { type: "barChart", label: "Usage Trend", points: [
                { label: "7/23", value: 720000, valueLabel: "720K tokens" },
                { label: "7/24", value: 960000, valueLabel: "960K tokens" },
                { label: "7/25", value: 1200000, valueLabel: "1.2M tokens" },
              ], note: "Estimated from local Codex logs for this home." },
            ],
          };
        }
        throw new Error(`${command} unavailable`);
      },
    };
  });

  await page.goto("/");
  await page.getByRole("tab", { name: "Usage" }).click();
  await expect(page.getByText("58% left")).toBeVisible();
  await expect(page.getByText("Rate Limit Resets")).toBeVisible();
  await expect(page.getByText("1 available")).toBeVisible();
  await expect(page.getByText("$0.40 · 10 credits")).toBeVisible();
  await expect(page.getByRole("region", { name: "Codex usage history" })).toBeVisible();
  await expect(page.getByText("1.2M tokens")).toBeVisible();
  await expect(page.getByText("Model mix")).toBeVisible();
  await expect(page.getByRole("img", { name: /Past 30 days 12\.4M tokens/ })).toBeVisible();
  await page.getByText("Daily detail · 1 days").click();
  await expect(page.getByText("960K tokens")).toBeVisible();

  await page.getByRole("button", { name: "Refresh usage" }).click();

  await expect(page.locator(".usage-freshness[data-stale='true']")).toContainText("Outdated");
  await expect(page.getByText("58% left")).toBeVisible();
  await expect(page.getByText("Codex usage is rate limited. Try again shortly.")).toBeVisible();
});

// Percent left at every boundary of meterStatus.ts, with the level and words each must show,
// and the tone token the dot, the label and the bar all take (#376).
const METER_CASES = [
  { left: 100, level: "ok", label: "Available", tone: "--tone-ok" },
  { left: 46, level: "ok", label: "Available", tone: "--tone-ok" },
  { left: 45, level: "low", label: "Running low", tone: "--tone-low" },
  { left: 21, level: "low", label: "Running low", tone: "--tone-low" },
  { left: 20, level: "critical", label: "Nearly exhausted", tone: "--tone-critical" },
  { left: 1, level: "critical", label: "Nearly exhausted", tone: "--tone-critical" },
  { left: 0, level: "out", label: "Exhausted", tone: "--tone-out" },
] as const;

test("Usage meters take one of four tones by what is left, the same on the dot, the label and the bar", async ({ page }) => {
  await page.addInitScript((cases) => {
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "set_keep_awake") return false;
        if (command === "codex_usage") {
          return {
            providerId: "codex",
            displayName: "Codex",
            plan: "Pro",
            fetchedAt: "2026-08-13T06:00:00Z",
            lines: cases.map((entry) => ({ type: "progress", label: `Quota ${entry.left}`, used: 100 - entry.left, limit: 100 })),
          };
        }
        throw new Error(`${command} unavailable`);
      },
    };
  }, METER_CASES.map((entry) => ({ left: entry.left })));

  await page.goto("/");
  await page.getByRole("tab", { name: "Usage" }).click();

  const meters = page.locator(".usage-meter");
  await expect(meters).toHaveCount(METER_CASES.length);
  const tones = await page.evaluate((names) => {
    // Resolved through a probe, so a token defined as var(--done) compares as the colour it is.
    const probe = document.createElement("span");
    document.body.append(probe);
    const out = Object.fromEntries(names.map((name) => {
      probe.style.color = `var(${name})`;
      return [name, getComputedStyle(probe).color];
    }));
    probe.remove();
    return out;
  }, ["--tone-ok", "--tone-low", "--tone-critical", "--tone-out"]);
  // Four tones, four colours: yellow and orange per the approved frames, not one shared amber.
  expect(new Set(Object.values(tones)).size).toBe(4);
  expect(tones["--tone-low"]).toBe("rgb(250, 204, 21)");
  expect(tones["--tone-critical"]).toBe("rgb(255, 138, 61)");
  expect(tones["--tone-out"]).toBe("rgb(255, 107, 102)");

  for (const [index, entry] of METER_CASES.entries()) {
    const meter = meters.nth(index);
    await expect(meter, `${entry.left}% left`).toHaveAttribute("data-level", entry.level);
    await expect(meter.locator(".usage-meter-status"), `${entry.left}% left`).toHaveText(entry.label);
    await expect(meter.getByRole("progressbar")).toHaveAttribute("aria-valuenow", String(entry.left));
    const painted = await meter.evaluate((el) => ({
      label: getComputedStyle(el.querySelector(".usage-meter-status")!).color,
      dot: getComputedStyle(el.querySelector(".usage-status-dot")!).backgroundColor,
      fill: getComputedStyle(el.querySelector(".usage-meter-fill")!).backgroundColor,
    }));
    expect(painted, `${entry.left}% left`).toEqual({ label: tones[entry.tone], dot: tones[entry.tone], fill: tones[entry.tone] });
  }

  // The used/left toggle changes the number shown, never the level: that follows what is left.
  await page.getByRole("button", { name: "Usage settings" }).click();
  await page.getByRole("radio", { name: "Used" }).click();
  await page.getByRole("button", { name: "Usage settings" }).click();
  for (const [index, entry] of METER_CASES.entries()) {
    await expect(meters.nth(index), `${entry.left}% left, shown as used`).toHaveAttribute("data-level", entry.level);
    await expect(meters.nth(index).locator(".usage-meter-status")).toHaveText(entry.label);
    await expect(meters.nth(index).getByRole("progressbar")).toHaveAttribute("aria-valuenow", String(100 - entry.left));
  }
});

test("a meter with no reading is unavailable, untoned and without a bar", async ({ page }) => {
  await page.addInitScript(() => {
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "set_keep_awake") return false;
        if (command === "codex_usage") {
          return { providerId: "codex", displayName: "Codex", plan: "Pro", fetchedAt: "2026-08-13T06:00:00Z", lines: [
            { type: "progress", label: "Session", used: 30, limit: 100 },
            { type: "progress", label: "Weekly", limit: 100 },
          ] };
        }
        throw new Error(`${command} unavailable`);
      },
    };
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "Usage" }).click();
  const meters = page.locator(".usage-meter");
  await expect(meters).toHaveCount(2);
  await expect(meters.nth(0)).toHaveAttribute("data-level", "ok");
  await expect(meters.nth(1)).toHaveAttribute("data-level", "unavailable");
  await expect(meters.nth(1).locator(".usage-meter-status")).toHaveText("Unavailable");
  await expect(meters.nth(1)).toHaveAttribute("data-empty", "true");
  const painted = await meters.nth(1).evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--text-3)";
    document.body.append(probe);
    const muted = getComputedStyle(probe).color;
    probe.remove();
    return { muted, status: getComputedStyle(el.querySelector(".usage-meter-status")!).color, fill: getComputedStyle(el.querySelector(".usage-meter-fill")!).opacity };
  });
  expect(painted.status).toBe(painted.muted);
  expect(painted.fill).toBe("0");
});

test("Usage marks a native cached Status response as outdated instead of online", async ({ page }) => {
  await page.addInitScript(() => {
    let claudeCalls = 0;
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "set_keep_awake") return false;
        if (command === "claude_usage") {
          claudeCalls += 1;
          const lines = [
            { type: "progress", label: "Session", used: 25, limit: 100, resetsAt: "2026-07-25T14:00:00Z" },
            { type: "progress", label: "Weekly", used: 11, limit: 100, resetsAt: "2026-07-30T12:00:00Z" },
          ];
          if (claudeCalls > 1) {
            lines.push({ type: "text", label: "Status", value: "Live usage rate limited; showing last good values." });
          }
          return {
            providerId: "claude",
            displayName: "Claude Code",
            plan: "Max",
            fetchedAt: "2026-07-25T12:00:00Z",
            lines,
          };
        }
        throw new Error(`${command} unavailable`);
      },
    };
  });

  await page.goto("/");
  await page.getByRole("tab", { name: "Usage" }).click();
  await page.getByRole("tab", { name: "Claude Code Online" }).click();
  await expect(page.getByText("75% left")).toBeVisible();

  await page.getByRole("button", { name: "Refresh usage" }).click();

  await expect(page.locator(".usage-freshness[data-stale='true']")).toContainText("Outdated");
  await expect(page.getByText("75% left")).toBeVisible();
  await expect(page.getByText("Live usage rate limited; showing last good values.")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Claude Code Outdated" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Claude Code Online" })).toHaveCount(0);
});

test("Usage does not label a status-only provider response as outdated", async ({ page }) => {
  await page.addInitScript(() => {
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "set_keep_awake") return false;
        if (command === "claude_usage") {
          return {
            providerId: "claude",
            displayName: "Claude Code",
            fetchedAt: "2026-07-25T12:00:00Z",
            lines: [{ type: "text", label: "Status", value: "Claude Code usage unavailable." }],
          };
        }
        throw new Error(`${command} unavailable`);
      },
    };
  });

  await page.goto("/");
  await page.getByRole("tab", { name: "Usage" }).click();
  await page.getByRole("tab", { name: "Claude Code" }).click();

  await expect(page.getByText("Claude Code usage unavailable.")).toBeVisible();
  await expect(page.locator(".usage-freshness")).toHaveCount(0);
});

test("Usage keeps a valid empty Antigravity summary online as no quota data", async ({ page }) => {
  await page.addInitScript(() => {
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "set_keep_awake") return false;
        if (command === "agy_usage") {
          return {
            providerId: "agy",
            displayName: "Antigravity",
            plan: "Pro",
            fetchedAt: "2026-07-25T12:00:00Z",
            lines: [],
          };
        }
        throw new Error(`${command} unavailable`);
      },
    };
  });

  await page.goto("/");
  await page.getByRole("tab", { name: "Usage" }).click();
  await page.getByRole("tab", { name: "Antigravity Online" }).click();

  await expect(page.getByText("No quota data from current source")).toBeVisible();
  await expect(page.locator(".usage-freshness")).toContainText("Updated");
});

test("Usage hydrates a persisted last-good snapshot before a reload refresh completes", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("gyredeck.usage-snapshots.v1", JSON.stringify({
      codex: {
        providerId: "codex",
        fetchedAt: "2026-07-25T12:00:00Z",
        plan: "Pro",
        lines: [{ type: "progress", label: "Session", used: 42, limit: 100 }],
      },
    }));
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "set_keep_awake") return false;
        throw new Error(`${command} unavailable`);
      },
    };
  });

  await page.goto("/");
  await page.getByRole("tab", { name: "Usage" }).click();

  await expect(page.getByText("58% left")).toBeVisible();
  await expect(page.locator(".usage-freshness[data-stale='true']")).toContainText("Outdated");
});

test("refreshing usage says so on the control while the numbers stay put", async ({ page }) => {
  await page.addInitScript(() => {
    let release: (() => void) | null = null;
    (window as typeof window & { __releaseUsage: () => void }).__releaseUsage = () => release?.();
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "set_keep_awake") return false;
        if (command === "codex_usage") {
          // The first call answers immediately; later ones hang until the test
          // releases them, which is the window where the spinner should be visible.
          if (release === null) {
            release = () => {};
          } else {
            await new Promise<void>((resolve) => { release = resolve; });
          }
          return {
            providerId: "codex",
            displayName: "Codex",
            plan: "Plus",
            fetchedAt: new Date().toISOString(),
            lines: [{ type: "progress", label: "Weekly", used: 42, limit: 100, remainingLabel: "58% left" }],
          };
        }
        throw new Error(`${command} unavailable`);
      },
    };
  });

  await page.goto("/");
  await page.getByRole("tab", { name: "Usage" }).click();
  await expect(page.getByText("58% left")).toBeVisible();

  await page.getByRole("button", { name: "Refresh usage" }).click();

  // The control is the only thing that moves: a reading already on screen is the
  // previous one and must not blink out while a new one is on its way.
  const refreshing = page.getByRole("button", { name: "Refreshing usage" });
  await expect(refreshing).toBeDisabled();
  await expect(refreshing.locator(".usage-spin")).toBeVisible();
  await expect(page.getByText("58% left")).toBeVisible();

  await page.evaluate(() => (window as typeof window & { __releaseUsage: () => void }).__releaseUsage());
  await expect(page.getByRole("button", { name: "Refresh usage" })).toBeEnabled();
});

test("a provider whose reading went stale sinks behind the online ones in the Usage tabs (#197)", async ({ page }) => {
  // Antigravity is declared first. Once its refresh fails it keeps its old numbers but loses
  // its green dot, and it used to keep leading the tabs anyway, because the order counted kept
  // numbers as "in use" while the dot asked whether the provider was online.
  await page.addInitScript(() => {
    let agyCalls = 0;
    const snapshot = (providerId: string, displayName: string) => ({
      providerId,
      displayName,
      plan: "Pro",
      fetchedAt: "2026-10-24T01:00:00Z",
      lines: [{ type: "progress", label: "Session", used: 30, limit: 100, resetsAt: "2026-10-24T05:00:00Z" }],
    });
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "set_keep_awake") return false;
        if (command === "agy_usage") {
          agyCalls += 1;
          if (agyCalls > 1) throw new Error("Antigravity usage is unavailable right now.");
          return snapshot("agy", "Antigravity");
        }
        if (command === "claude_usage") return snapshot("claude", "Claude Code");
        if (command === "codex_usage") return snapshot("codex", "Codex");
        throw new Error(`${command} unavailable`);
      },
    };
  });

  await page.goto("/");
  await page.getByRole("tab", { name: "Usage" }).click();
  const tabs = page.locator("[id^='usage-tab-']:not(#usage-tab-settings)");
  // The premise: all three online, so declaration order holds and Antigravity leads.
  await expect(tabs).toHaveText([/Antigravity/, /Claude Code/, /Codex/]);
  await expect(page.locator("#usage-tab-agy .usage-side-dot")).toHaveCount(1);

  await page.getByRole("button", { name: "Refresh usage" }).click();

  await expect(page.locator("#usage-tab-agy .usage-side-dot")).toHaveCount(0);
  await expect(tabs).toHaveText([/Claude Code/, /Codex/, /Antigravity/]);
});
