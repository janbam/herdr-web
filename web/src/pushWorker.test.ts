import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

/** Load the shipped worker unchanged, observing its browser-owned event boundaries. */
function worker() {
  const handlers = new Map<string, (event: object) => void>();
  const showNotification = vi.fn<(title: string, options: { body: string; icon: string }) => Promise<void>>().mockResolvedValue(undefined);
  const focus = vi.fn(async () => undefined);
  const openWindow = vi.fn(async () => undefined);
  const matchAll = vi.fn(async () => [{ url: "https://herdr.test/app/?tab=1", focus }]);
  runInNewContext(readFileSync(new URL("../public/push-worker.js", import.meta.url), "utf8"), {
    URL, location: { href: "https://herdr.test/app/push-worker.js" },
    registration: { showNotification }, clients: { matchAll, openWindow },
    addEventListener: (name: string, callback: (event: object) => void) => handlers.set(name, callback),
  });
  return { handlers, showNotification, focus, openWindow, matchAll };
}

describe("notification worker", () => {
  it("displays a system notification for valid and malformed pushes without trusting supplied URLs", async () => {
    const w = worker();
    for (const json of [() => ({ body: "Agent p1 is now blocked.", url: "https://evil.test" }), () => { throw new Error("bad payload"); }]) {
      let pending: Promise<void> | undefined;
      w.handlers.get("push")?.({ data: { json }, waitUntil: (promise: Promise<void>) => { pending = promise; } });
      await pending;
    }
    expect(w.showNotification.mock.calls[0]).toEqual(["Herdr", { body: "Agent p1 is now blocked.", icon: "https://herdr.test/app/herdr-logo-192.png" }]);
    expect(w.showNotification.mock.calls[1][1].body).toContain("Open Herdr");
  });

  it("focuses the installed app or opens it when closed, never a push-controlled URL", async () => {
    const w = worker();
    const close = vi.fn();
    const click = async () => {
      let pending: Promise<void> | undefined;
      w.handlers.get("notificationclick")?.({ notification: { close, data: { url: "https://evil.test" } }, waitUntil: (promise: Promise<void>) => { pending = promise; } });
      await pending;
    };
    await click();
    expect(w.focus).toHaveBeenCalledOnce();
    expect(w.openWindow).not.toHaveBeenCalled();
    w.matchAll.mockResolvedValue([]);
    await click();
    expect(w.openWindow).toHaveBeenCalledWith("https://herdr.test/app/");
    expect(close).toHaveBeenCalledTimes(2);
  });
});
