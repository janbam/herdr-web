/** Display only bounded notification text. Push payloads cannot choose click destinations. */
globalThis.addEventListener("push", (event) => {
  let body = "An agent needs your attention. Open Herdr to check its status.";
  if (event.data) {
    try {
      const payload = event.data.json();
      if (typeof payload.body === "string" && payload.body.length <= 500) body = payload.body;
    } catch {
      // Every received push remains visible, including a malformed provider payload.
    }
  }
  event.waitUntil(globalThis.registration.showNotification("Herdr", {
    body,
    icon: new globalThis.URL("herdr-logo-192.png", globalThis.location.href).href,
  }));
});

/** Return only to the app that installed this worker, never a URL from a push message. */
globalThis.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const appUrl = new globalThis.URL(".", globalThis.location.href).href;
  event.waitUntil((async () => {
    const windows = await globalThis.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => {
      const url = new globalThis.URL(client.url);
      return `${url.origin}${url.pathname}` === appUrl;
    });
    if (existing) await existing.focus();
    else await globalThis.clients.openWindow(appUrl);
  })());
});
