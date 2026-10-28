import type { BridgeRuntime } from "./bridge";
import { apiErrorMessage } from "./bridgeApi";
import { fetchWithTimeout } from "./fetchWithTimeout";

/** Browser-specific transition choices persisted on the selected bridge. */
export type PushPreferences = { blocked: boolean; idle: boolean };

/** Server enrollment state combined with this browser's durable push subscription. */
export type PushState = {
  publicKey: string | null;
  registration: ServiceWorkerRegistration | null;
  subscription: PushSubscription | null;
  preferences: PushPreferences | null;
};

/** Explain capability failures before asking for permission or contacting the bridge. */
export function pushUnsupportedReason(): string | null {
  if (!window.isSecureContext) return "Web Push needs HTTPS or localhost on this device. Plain HTTP over a LAN address is not supported.";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return "This browser does not support Web Push. Use Firefox or another supported browser, not the Android app's embedded view.";
  }
  return null;
}

/** Isolate each bridge connection's subscription without taking control of app pages. */
export async function pushScope(connectionKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(connectionKey));
  const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return new URL(`__push/${key}/`, new URL(".", window.location.href)).href;
}

/** Read settings without registering a worker, prompting, or changing subscriptions. */
export async function loadPushState(runtime: BridgeRuntime, signal?: AbortSignal): Promise<PushState> {
  const response = await fetchWithTimeout(runtime.httpUrl("/api/push/config"), { signal });
  if (!response.ok) throw new Error(await apiErrorMessage(response) ?? "This bridge does not support Web Push. Update the bridge and try again.");
  const config: unknown = await response.json();
  if (!isRecord(config) || !(config.public_key === null || typeof config.public_key === "string")) throw new Error("Invalid push configuration from bridge");
  const scope = await pushScope(runtime.connectionKey);
  const candidate = await navigator.serviceWorker.getRegistration(scope);
  const registration = candidate?.scope === scope ? candidate : null;
  const subscription = await registration?.pushManager.getSubscription() ?? null;
  const preferences = config.public_key && subscription
    ? await updatePush(runtime, { action: "read", endpoint: subscription.endpoint }, signal) : null;
  return { publicKey: config.public_key, registration, subscription, preferences };
}

/** Permission must be requested by the click handler before awaiting registration or network I/O. */
export async function enablePush(runtime: BridgeRuntime, publicKey: string, preferences: PushPreferences, permission: Promise<NotificationPermission>): Promise<PushState> {
  if (await permission !== "granted") throw new Error("Notifications are not allowed. Enable them in Firefox's site permissions and Android's notification settings, then retry.");
  const scope = await pushScope(runtime.connectionKey);
  const registration = await navigator.serviceWorker.register(new URL("push-worker.js", new URL(".", window.location.href)), { scope });
  await waitForPushWorker(registration);
  const key = decodePushKey(publicKey);
  let subscription = await registration.pushManager.getSubscription();
  // A replaced bridge signing key requires explicit re-enrollment, never silent dual subscriptions.
  const existingKey = subscription?.options.applicationServerKey;
  if (subscription && (!existingKey || !sameBytes(new Uint8Array(existingKey), key))) {
    if (!await subscription.unsubscribe()) throw new Error("Could not replace the old push subscription. Retry in Firefox's site settings.");
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await updatePush(runtime, { action: "save", subscription: subscription.toJSON(), preferences });
  return { publicKey, registration, subscription, preferences };
}

/** Remove bridge delivery first. Keeping the browser endpoint permits reliable re-enrollment. */
export async function disablePush(runtime: BridgeRuntime, endpoint: string): Promise<void> {
  await updatePush(runtime, { action: "remove", endpoint });
}

/** Keep endpoints in bounded POST bodies rather than URLs or browser history. */
export async function updatePush(runtime: BridgeRuntime, request: object, signal?: AbortSignal): Promise<PushPreferences | null> {
  const response = await fetchWithTimeout(runtime.httpUrl("/api/push/subscription"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal, timeoutMs: 15000,
  });
  if (!response.ok) throw new Error(await apiErrorMessage(response) ?? `Push request failed (${response.status})`);
  const result: unknown = await response.json();
  if (isRecord(result)) {
    if (result.preferences === null) return null;
    const preferences = result.preferences;
    if (isRecord(preferences) && typeof preferences.blocked === "boolean" && typeof preferences.idle === "boolean") {
      return { blocked: preferences.blocked, idle: preferences.idle };
    }
  }
  throw new Error("Invalid push preferences from bridge");
}

/** Decode an uncompressed P-256 public key for the PushManager API. */
export function decodePushKey(value: string): Uint8Array<ArrayBuffer> {
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error("Invalid bridge push signing key");
  return bytes;
}

/** Compare public signing keys without depending on base64 padding conventions. */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Wait for this synthetic scope's worker, not navigator.serviceWorker.ready for the page. */
async function waitForPushWorker(registration: ServiceWorkerRegistration): Promise<void> {
  if (registration.active?.state === "activated") return;
  const worker = registration.installing ?? registration.waiting ?? registration.active;
  if (!worker) throw new Error("Notification worker was not installed");
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      worker.removeEventListener("statechange", check);
      if (error) reject(error); else resolve();
    };
    const check = () => {
      if (worker.state === "activated") finish();
      if (worker.state === "redundant") finish(new Error("Notification worker installation failed"));
    };
    const timer = setTimeout(() => finish(new Error("Notification worker activation timed out. Retry enabling notifications.")), 15000);
    worker.addEventListener("statechange", check);
    check();
  });
}

/** Narrow untrusted bridge JSON at its boundary. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
