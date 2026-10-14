/** @vitest-environment jsdom */
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeRuntime } from "./bridge";
import { decodePushKey, disablePush, enablePush, loadPushState, pushScope, pushUnsupportedReason } from "./pushNotifications";

/** Isolated bridge identity with a real URL builder. */
function runtime(id = "host-a"): BridgeRuntime {
  return {
    id, mode: "configured", label: id, color: "#fff", backend: null, connectionKey: `configured:${id}:https://${id}.test`, resumeToken: 0,
    capabilities: null, capabilityState: "ready", capabilityError: null, canConnect: true,
    httpUrl: (path) => `https://${id}.test${path}`, wsUrl: (path) => `wss://${id}.test${path}`,
  };
}

/** Valid uncompressed P-256 public key encoding for the browser adapter. */
const publicKey = "BFH9VX_qI6xhNMwFUrQPb28D6P28bcVt1McHPlF3kWkrBzYh53_u1n7IoSjTqvMaqOtA7oQevJ2jDGLwa_6eFdo";
/** Browser subscription handle exposing only the lifecycle methods the adapter uses. */
const subscription = {
  endpoint: "https://updates.push.services.mozilla.com/wpush/v2/token",
  options: { applicationServerKey: decodePushKey(publicKey).buffer },
  toJSON: () => ({ endpoint: subscription.endpoint, keys: { p256dh: publicKey, auth: "abcdefghijklmnopqrstuv" } }),
  unsubscribe: vi.fn(async () => true),
};
/** Browser registration boundary, not a substitute for real Firefox interoperability testing. */
const activeWorker = Object.assign(new EventTarget(), { state: "activated" });
/** Registration with an independently observable activation lifecycle. */
const registration = {
  scope: "", active: activeWorker,
  pushManager: { getSubscription: vi.fn<() => Promise<typeof subscription | null>>().mockResolvedValue(subscription), subscribe: vi.fn(async () => subscription) },
};
/** Worker container methods observed at enrollment and read boundaries. */
const worker = { getRegistration: vi.fn(), register: vi.fn<(url: URL, options: RegistrationOptions) => Promise<typeof registration>>().mockResolvedValue(registration) };
/** Controlled HTTP boundary for project-owned request and validation policy. */
const fetchMock = vi.fn();

beforeEach(() => {
  activeWorker.state = "activated";
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", { requestPermission: vi.fn(async () => "granted") });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: worker });
  vi.stubGlobal("fetch", fetchMock);
  worker.getRegistration.mockResolvedValue(undefined);
  fetchMock.mockImplementation(async (_url, init) => new Response(JSON.stringify(init?.method === "POST" ? { preferences: { blocked: true, idle: true } } : { public_key: publicKey })));
});

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("Web Push enrollment", () => {
  it("requires a secure browser context and keeps separate scopes for separate bridge connections", async () => {
    expect(pushUnsupportedReason()).toBeNull();
    vi.stubGlobal("isSecureContext", false);
    expect(pushUnsupportedReason()).toContain("HTTPS");
    expect(await pushScope("bridge-a")).not.toBe(await pushScope("bridge-b"));
    expect(await pushScope("bridge-a")).toBe(await pushScope("bridge-a"));
  });

  it("does not enroll or prompt when reading settings and rejects an ancestor registration", async () => {
    worker.getRegistration.mockResolvedValue({ ...registration, scope: "http://localhost/" });
    const loaded = await loadPushState(runtime());
    expect(loaded.subscription).toBeNull();
    expect(loaded.preferences).toBeNull();
    expect(worker.register).not.toHaveBeenCalled();
    expect(Notification.requestPermission).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("restores preferences for this exact browser subscription without exposing endpoints in URLs", async () => {
    registration.scope = await pushScope(runtime().connectionKey);
    worker.getRegistration.mockResolvedValue(registration);
    const loaded = await loadPushState(runtime());
    expect(loaded.preferences).toEqual({ blocked: true, idle: true });
    expect(fetchMock.mock.calls[1][0]).toBe("https://host-a.test/api/push/subscription");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ action: "read", endpoint: subscription.endpoint });
  });

  it("permission denial leaves both browser registration and bridge enrollment untouched", async () => {
    await expect(enablePush(runtime(), publicKey, { blocked: true, idle: true }, Promise.resolve("denied"))).rejects.toThrow("not allowed");
    expect(worker.register).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("saves the selected transitions on the selected bridge and reuses its subscription", async () => {
    const preferences = { blocked: false, idle: true };
    const loaded = await enablePush(runtime("host-b"), publicKey, preferences, Promise.resolve("granted"));
    expect(loaded.preferences).toEqual(preferences);
    expect(worker.register.mock.calls[0][1]).toEqual({ scope: await pushScope(runtime("host-b").connectionKey) });
    expect(fetchMock.mock.calls[0][0]).toBe("https://host-b.test/api/push/subscription");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ action: "save", subscription: subscription.toJSON(), preferences });
    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("waits for its own installing worker and creates a fresh subscription with the bridge key", async () => {
    activeWorker.state = "activating";
    const listen = vi.spyOn(activeWorker, "addEventListener");
    registration.pushManager.getSubscription.mockResolvedValueOnce(null);
    const enabling = enablePush(runtime(), publicKey, { blocked: true, idle: false }, Promise.resolve("granted"));
    await vi.waitFor(() => expect(listen).toHaveBeenCalledWith("statechange", expect.any(Function)));
    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
    activeWorker.state = "activated";
    activeWorker.dispatchEvent(new Event("statechange"));
    const loaded = await enabling;
    expect(loaded.subscription).toBe(subscription);
    expect(registration.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: decodePushKey(publicKey) });
    listen.mockRestore();
  });

  it("failed saves stay visible and disabling removes only this bridge enrollment", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Storage unavailable" }), { status: 502 }));
    await expect(enablePush(runtime(), publicKey, { blocked: true, idle: true }, Promise.resolve("granted"))).rejects.toThrow("Storage unavailable");
    await disablePush(runtime("host-b"), subscription.endpoint);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ action: "remove", endpoint: subscription.endpoint });
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
  });
});
