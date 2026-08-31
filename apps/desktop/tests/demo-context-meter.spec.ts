import { expect, test } from "@playwright/test";

test("context window resolves by model family, and unknown models stay unresolved", async ({ page }) => {
  await page.goto("/?demo=1");
  const result = await page.evaluate(async () => {
    const { resolveContextWindow } = await import("/src/features/session/contextWindow.ts");
    return {
      opus5: resolveContextWindow("claude-opus-5"),
      // Legacy Opus kept a 1M window; this is the model that shipped with no bar.
      opus4_8: resolveContextWindow("claude-opus-4-8"),
      fable5: resolveContextWindow("claude-fable-5"),
      sonnet4_6: resolveContextWindow("claude-sonnet-4-6"),
      sonnet4_5: resolveContextWindow("claude-sonnet-4-5"),
      // Dated snapshots and aliases must fall back to the family prefix.
      haikuDated: resolveContextWindow("claude-haiku-4-5-20251001"),
      sonnet4_5Dated: resolveContextWindow("claude-sonnet-4-5-20250929"),
      // Not Claude, and Claude models we have no verified figure for.
      antigravity: resolveContextWindow("gpt-5.6-sol"),
      opus4_5: resolveContextWindow("claude-opus-4-5"),
      empty: resolveContextWindow(""),
      nullish: resolveContextWindow(null),
    };
  });

  expect(result).toEqual({
    opus5: 1_000_000,
    opus4_8: 1_000_000,
    fable5: 1_000_000,
    sonnet4_6: 1_000_000,
    sonnet4_5: 200_000,
    haikuDated: 200_000,
    sonnet4_5Dated: 200_000,
    antigravity: null,
    opus4_5: null,
    empty: null,
    nullish: null,
  });
});

test("context usage survives the event cap that evicts the turn it came from", async ({ page }) => {
  await page.goto("/?demo=1");
  const result = await page.evaluate(async () => {
    const { collectContextUsage, buildContextMeter } = await import("/src/features/session/contextWindow.ts");
    const { mergeSessionEvents } = await import("/src/features/session/eventRegistry.ts");
    const { MAX_SESSION_EVENTS_PER_SESSION } = await import("/src/features/session/constants.ts");

    const envelope = (index: number, type: string, data: unknown) => ({
      version: 2,
      id: `cap-${index}`,
      timestamp: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
      agentId: "agent",
      agentName: "Claude Code",
      conversationId: "conv-cap",
      cwd: "/tmp",
      model: "claude-opus-5",
      permissionMode: "default",
      runtime: { sourcePid: 1, sourcePpid: 0, sourceStartedAtMs: 0, sourceKind: "claudeCodeHook" },
      type,
      data,
    });

    // A completed turn, then one busy turn's worth of tool traffic on top of it.
    const turn = envelope(0, "turn_complete", {
      hookEventName: "Stop",
      source: "hook",
      message: null,
      usage: { inputTokens: 2, outputTokens: 341, cacheReadTokens: 301_854, cacheCreationTokens: 763 },
    });
    const noise = Array.from({ length: MAX_SESSION_EVENTS_PER_SESSION * 2 }, (_, i) =>
      envelope(i + 1, "tool_start", { toolCallId: `t${i}`, toolName: "Read", argKeys: ["file_path"] }));
    const events = [turn, ...noise];

    // The session event registry drops it — this is the regression the store exists for.
    const registry = mergeSessionEvents({}, events as never);
    const survivesInRegistry = (registry["conv-cap"] ?? []).some((e: { type: string }) => e.type === "turn_complete");

    const usage = collectContextUsage({}, events as never);
    const meter = buildContextMeter(usage["conv-cap"], "claude-opus-5");

    return {
      cap: MAX_SESSION_EVENTS_PER_SESSION,
      retainedByRegistry: (registry["conv-cap"] ?? []).length,
      survivesInRegistry,
      used: meter?.used ?? null,
      window: meter?.window ?? null,
      percent: meter ? Math.round(meter.ratio! * 100) : null,
    };
  });

  expect(result.survivesInRegistry).toBe(false);
  expect(result.retainedByRegistry).toBe(result.cap);
  // Still reported, from the separate store.
  expect(result.used).toBe(302_619);
  expect(result.window).toBe(1_000_000);
  expect(result.percent).toBe(30);
});

test("model is tracked apart from usage so a scopeless turn still resolves a window", async ({ page }) => {
  await page.goto("/?demo=1");
  const result = await page.evaluate(async () => {
    const { collectContextUsage, buildContextMeter } = await import("/src/features/session/contextWindow.ts");

    const at = (offset: number) => new Date(1_700_000_000_000 + offset * 1_000).toISOString();
    const envelope = (id: string, offset: number, model: string | null, type: string, data: unknown) => ({
      version: 2,
      id,
      timestamp: at(offset),
      agentId: "agent",
      agentName: "Claude Code",
      conversationId: "conv-scope",
      cwd: "/tmp",
      model,
      permissionMode: "default",
      runtime: { sourcePid: 1, sourcePpid: 0, sourceStartedAtMs: 0, sourceKind: "claudeCodeHook" },
      type,
      data,
    });

    const usageData = (cacheRead: number) => ({
      hookEventName: "Stop",
      source: "hook",
      message: null,
      usage: { inputTokens: 2, outputTokens: 100, cacheReadTokens: cacheRead, cacheCreationTokens: 0 },
    });

    // An early event names the model; the turn_complete relayed through /hook/stop
    // arrives with model unset because the bridge could not resolve the scope.
    const scopeless = collectContextUsage({}, [
      envelope("a", 0, "claude-opus-4-8", "conversation_open", { reason: "startup", previousConversationId: null }),
      envelope("b", 1, null, "turn_complete", usageData(500_000)),
    ] as never);

    // Out-of-order delivery must not let an older turn overwrite a newer one.
    const outOfOrder = collectContextUsage({}, [
      envelope("d", 9, "claude-opus-5", "turn_complete", usageData(900_000)),
      envelope("c", 2, "claude-opus-5", "turn_complete", usageData(100_000)),
    ] as never);

    const unchanged = collectContextUsage(scopeless, [
      envelope("e", 3, null, "tool_start", { toolCallId: "t", toolName: "Read", argKeys: [] }),
    ] as never);

    const scopelessMeter = buildContextMeter(scopeless["conv-scope"], null);
    const outOfOrderMeter = buildContextMeter(outOfOrder["conv-scope"], null);

    return {
      stickyModel: scopeless["conv-scope"].model,
      scopelessWindow: scopelessMeter?.window ?? null,
      scopelessUsed: scopelessMeter?.used ?? null,
      newestWins: outOfOrderMeter?.used ?? null,
      // Same reference back when a batch changes nothing, to avoid re-renders.
      sameReference: unchanged === scopeless,
      // No usage at all means no meter, rather than a zero-width bar.
      emptyMeter: buildContextMeter(undefined, "claude-opus-5"),
    };
  });

  expect(result.stickyModel).toBe("claude-opus-4-8");
  expect(result.scopelessWindow).toBe(1_000_000);
  expect(result.scopelessUsed).toBe(500_002);
  expect(result.newestWins).toBe(900_002);
  expect(result.sameReference).toBe(true);
  expect(result.emptyMeter).toBeNull();
});

test("session detail shows the context meter for Claude and omits it otherwise", async ({ page }) => {
  await page.goto("/?demo=1&demoScenario=context");
  await page.locator(".session-row-main").click();

  const meter = page.locator(".session-context-meter");
  await expect(meter).toContainText("302.6K");
  await expect(meter).toContainText("1M");
  await expect(meter).toContainText("30%");
  await expect(meter).toContainText("301.9K cached");
  // The number is measured when the Stop hook fires, so it is labelled as such.
  await expect(meter).toContainText("last turn");

  const bar = meter.getByRole("progressbar");
  await expect(bar).toHaveAttribute("aria-valuenow", "30");
  await expect(bar).toHaveAttribute("aria-valuetext", "30% of context used");

  // Antigravity reports no token usage, so its sessions carry no meter at all.
  await page.goto("/?demo=1&demoScenario=done");
  await page.locator(".session-row-main").click();
  await expect(page.locator(".session-context-summary")).toBeVisible();
  await expect(page.locator(".session-context-meter")).toHaveCount(0);
});
