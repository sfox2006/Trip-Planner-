// Build injects verified public asset hashes. No private blobs, API data or backups.
const shell = self.__PLANNER_SHELL__;
const scope = self.registration.scope;
const prefix = `personal-trip-planner-shell:${scope}:`;
const cacheName = `${prefix}${shell?.version}`;
const urls = new Map(
  (shell?.assets || []).map((a) => [new URL(a.path, scope).href, a.sha256]),
);
const indexURL = new URL("index.html", scope).href;
async function verifiedResponse(url, expected) {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok || response.type === "opaque")
    throw Error("Public shell download failed.");
  const hash = await crypto.subtle.digest(
    "SHA-256",
    await response.clone().arrayBuffer(),
  );
  const actual = [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (actual !== expected)
    throw Error("Public shell changed during update. Retry later.");
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      if (
        !shell ||
        !/^[a-f0-9]{64}$/.test(shell.version) ||
        !urls.has(indexURL)
      )
        throw Error("Offline shell requires npm run build.");
      const cache = await caches.open(cacheName);
      try {
        for (const [url, expected] of urls) {
          await cache.put(url, await verifiedResponse(url, expected));
        }
      } catch (e) {
        await caches.delete(cacheName);
        throw e;
      }
      // Native waiting lifecycle preserves active tabs/forms until they all close.
      // Never skipWaiting or force a schema-changing reload.
    })(),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith(prefix) && name !== cacheName)
          await caches.delete(name);
    })(),
  );
});
self.addEventListener("message", (event) => {
  if (event.data?.type !== "PTP_SHELL_HEALTH" || !event.ports[0]) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(cacheName);
      const keys = new Set((await cache.keys()).map((r) => r.url));
      event.ports[0].postMessage({
        ready: [...urls.keys()].every((url) => keys.has(url)),
      });
    })(),
  );
});
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  let url = event.request.url;
  if (event.request.mode === "navigate") {
    const target = new URL(url);
    if (
      target.origin === new URL(scope).origin &&
      [scope, indexURL].includes(target.origin + target.pathname)
    )
      url = indexURL;
  }
  if (!urls.has(url)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(cacheName);
      const response = await cache.match(url);
      // A cleared/evicted shell does not silently combine different releases.
      if (response) return response;
      try {
        const restored = await verifiedResponse(url, urls.get(url));
        await cache.put(url, restored.clone());
        return restored;
      } catch {
        for (const client of await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        }))
          if (client.url.startsWith(scope))
            client.postMessage({ type: "PTP_SHELL_UNAVAILABLE" });
        return new Response(
          "Offline copy was cleared or changed. Reconnect, close every planner window, then reopen. Saved trips remain in browser storage.",
          { status: 503, headers: { "Content-Type": "text/plain" } },
        );
      }
    })(),
  );
});
