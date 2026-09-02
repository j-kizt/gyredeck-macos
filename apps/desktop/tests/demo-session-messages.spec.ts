import { expect, test } from "@playwright/test";

test("session messages state their reachability instead of offering a dead send box", async ({ page }) => {
  await page.goto("/?demo=1&demoScenario=long-llm");
  await page.locator(".session-row-main").click();

  const messages = page.locator(".session-messages");
  await expect(messages).toBeVisible();
  // Nothing has been exchanged, and the empty state says what the panel is for
  // rather than leaving a blank box.
  await expect(messages.locator(".session-messages-empty")).toContainText("Nothing yet");

  // The browser demo has no native runtime to deliver through, so there is no input
  // to type into — a send that silently goes nowhere is worse than no send button.
  await expect(messages.locator(".session-messages-input")).toHaveCount(0);
  await expect(messages.locator(".session-messages-note")).toContainText("Browser demo cannot send messages");
});
