import { useEffect, useRef, useState } from "react";
import { useBridge, type BridgeRuntime } from "./bridge";
import { disablePush, enablePush, loadPushState, pushUnsupportedReason, updatePush, type PushPreferences, type PushState } from "./pushNotifications";

/** Per-browser, per-bridge Web Push settings, independent of sidebar host enablement. */
export function PushNotificationSettings() {
  const bridge = useBridge();
  const [selectedId, setSelectedId] = useState(bridge.lastSelectedBridgeId);
  const runtime = bridge.availableRuntimes.find((r) => r.id === selectedId) ?? bridge.availableRuntimes[0];
  const unsupported = pushUnsupportedReason();
  return <div className="settings-section settings-section-flat">
    <div className="settings-label">Agent notifications</div>
    <p className="backend-note">Receive system notifications when an agent changes from working to blocked or idle, even with this page closed. Configure each bridge separately for this browser.</p>
    {unsupported ? <p role="status">{unsupported}</p> : runtime ? <>
      <label className="field-label">Bridge
        <select value={runtime.id} onChange={(event) => setSelectedId(event.target.value)}>
          {bridge.availableRuntimes.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
      </label>
      <BridgePushSettings key={runtime.connectionKey} runtime={runtime} />
    </> : <p>Add a bridge first.</p>}
    <p className="backend-note">Delivery needs internet access and browser and Android notification permission. Firefox Android uses Mozilla's push service and Firebase Cloud Messaging. Battery restrictions or force-stopping Firefox can prevent delivery. Disabling a bridge in the sidebar does not disable push.</p>
  </div>;
}

/** Own enrollment and request lifetimes for exactly one bridge connection. */
export function BridgePushSettings({ runtime }: { runtime: BridgeRuntime }) {
  const [state, setState] = useState<PushState | null>(null);
  const [preferences, setPreferences] = useState<PushPreferences>({ blocked: true, idle: true });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    // Read existing enrollment without prompting or making a new worker.
    loadPushState(runtime, controller.signal).then((loaded) => {
      if (controller.signal.aborted) return;
      setState(loaded);
      if (loaded.preferences) setPreferences(loaded.preferences);
      setMessage("");
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Could not load push settings");
    });
    return () => controller.abort();
  }, [runtime.connectionKey, runtime.httpUrl, retry]);

  /** Serialize button actions before their first await and surface failures without false success. */
  const run = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setMessage("");
    try { await action(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Push operation failed"); }
    finally { pending.current = false; setBusy(false); }
  };
  const enabled = state?.preferences !== null && state?.preferences !== undefined;
  if (!state) return <>
    <p role="status">{message || "Loading push settings..."}</p>
    {message && <button type="button" className="btn" onClick={() => setRetry((r) => r + 1)}>Retry</button>}
  </>;
  if (!state.publicKey) return <p role="status">Web Push is disabled on this bridge. Set HERDR_WEB_PUSH_SUBJECT=mailto:you@example.com in the bridge environment and restart it.</p>;
  const publicKey = state.publicKey;
  return <>
    <p role="status">{enabled ? "Notifications enabled for this browser." : "Notifications disabled for this browser."}</p>
    <p className="backend-note">Browser permission: {Notification.permission}. {Notification.permission === "denied" ? "Allow notifications in Firefox's site permissions and Android's settings before re-enabling." : ""}</p>
    <div className="settings-row"><label><input type="checkbox" checked={preferences.blocked} disabled={busy} onChange={(e) => setPreferences({ ...preferences, blocked: e.target.checked })} /> Working → blocked</label></div>
    <div className="settings-row"><label><input type="checkbox" checked={preferences.idle} disabled={busy} onChange={(e) => setPreferences({ ...preferences, idle: e.target.checked })} /> Working → idle</label></div>
    <div className="modal-actions">
      <button type="button" className="btn btn-primary" disabled={busy || (!preferences.blocked && !preferences.idle)} onClick={() => {
        // Request permission synchronously in the user gesture, before any asynchronous setup.
        if (pending.current) return;
        const permission = Notification.requestPermission();
        void run(async () => {
          const next = await enablePush(runtime, publicKey, preferences, permission);
          setState(next);
          setMessage("Notification preferences saved.");
        });
      }}>{enabled ? "Save preferences" : "Enable notifications"}</button>
      <button type="button" className="btn" disabled={busy || !enabled} onClick={() => void run(async () => {
        if (!state.subscription) return;
        await updatePush(runtime, { action: "test", endpoint: state.subscription.endpoint });
        setMessage("Test accepted by the push service. Check Android's notification shade.");
      })}>Send test notification</button>
      <button type="button" className="btn" disabled={busy || !state.subscription} onClick={() => void run(async () => {
        if (!state.subscription) return;
        await disablePush(runtime, state.subscription.endpoint);
        setState({ ...state, preferences: null });
        setMessage("Notifications disabled on this bridge.");
      })}>Disable notifications</button>
    </div>
    {message && <p role="status" className="modal-message">{message}</p>}
    <p className="backend-note">Notifications include the pane ID and status, not terminal output or agent titles. Re-enable after changing a bridge URL. Remove enrollment here before deleting a saved bridge.</p>
  </>;
}
