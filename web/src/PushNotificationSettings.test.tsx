/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BridgePushSettings } from "./PushNotificationSettings";
import { disablePush, enablePush, loadPushState, type PushState } from "./pushNotifications";
import type { BridgeRuntime } from "./bridge";

vi.mock("./pushNotifications", () => ({ loadPushState: vi.fn(), enablePush: vi.fn(), disablePush: vi.fn(), updatePush: vi.fn(), pushUnsupportedReason: () => null }));

/** One complete bridge runtime, ensuring actions retain the chosen connection. */
const runtime: BridgeRuntime = {
  id: "a", label: "Bridge A", color: "#fff", mode: "configured", backend: null, connectionKey: "a-url", resumeToken: 0,
  capabilities: null, capabilityState: "ready", capabilityError: null, canConnect: true, httpUrl: (path) => path, wsUrl: (path) => path,
};
/** Browser handles are irrelevant to UI behavior beyond the endpoint identity. */
const enrolled: PushState = {
  publicKey: "key", registration: null,
  subscription: {
    endpoint: "https://provider.test/token", expirationTime: null,
    options: { applicationServerKey: null, userVisibleOnly: true },
    getKey: () => null, toJSON: () => ({}), unsubscribe: async () => true,
  },
  preferences: { blocked: true, idle: false },
};

/** React root owned by each test and released after pending effects settle. */
let root: ReturnType<typeof createRoot>;
/** Render target for user-visible enrollment state and controls. */
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal("Notification", { requestPermission: vi.fn(() => Promise.resolve("granted")) });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

/** Find a visible button by its user-facing label. */
function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}

it("permission or save failures never claim enabled notifications", async () => {
  vi.mocked(loadPushState).mockResolvedValue({ ...enrolled, subscription: null, preferences: null });
  vi.mocked(enablePush).mockRejectedValue(new Error("Notifications are not allowed"));
  await act(async () => root.render(<BridgePushSettings runtime={runtime} />));
  await act(async () => button("Enable notifications").click());
  expect(container.textContent).toContain("Notifications disabled for this browser.");
  expect(container.textContent).toContain("Notifications are not allowed");
  expect(button("Send test notification").disabled).toBe(true);
});

it("persists chosen transitions and preserves enabled state if disabling fails", async () => {
  vi.mocked(loadPushState).mockResolvedValue(enrolled);
  vi.mocked(enablePush).mockImplementation(async (_runtime, _key, preferences) => ({ ...enrolled, preferences }));
  vi.mocked(disablePush).mockRejectedValueOnce(new Error("Bridge offline"));
  await act(async () => root.render(<BridgePushSettings runtime={runtime} />));
  const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  expect(checkboxes[0].checked).toBe(true);
  expect(checkboxes[1].checked).toBe(false);
  await act(async () => checkboxes[1].click());
  await act(async () => button("Save preferences").click());
  expect(enablePush).toHaveBeenCalledWith(runtime, "key", { blocked: true, idle: true }, expect.any(Promise));
  await act(async () => button("Disable notifications").click());
  expect(container.textContent).toContain("Notifications enabled for this browser.");
  expect(container.textContent).toContain("Bridge offline");
  vi.mocked(disablePush).mockResolvedValueOnce();
  await act(async () => button("Disable notifications").click());
  expect(container.textContent).toContain("Notifications disabled for this browser.");
  expect(disablePush).toHaveBeenCalledWith(runtime, "https://provider.test/token");
});
