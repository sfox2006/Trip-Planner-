const $ = (id) => document.getElementById(id);
let installPrompt = null,
  offlineReady = false,
  updateReady = false,
  failure = false,
  installationObserved = false;
const installed = () =>
  installationObserved ||
  matchMedia("(display-mode: standalone)").matches ||
  navigator.standalone === true;
const state = $("pwa-state"),
  button = $("install-open"),
  dialog = $("install-dialog");
const nativeButton = $("install-native");
let opener;
function renderState() {
  const connection =
    navigator.onLine === false ? "Device offline" : "Device online";
  const copy = updateReady
    ? "Update ready — close every planner window and reopen to apply."
    : offlineReady
      ? "Offline copy ready."
      : failure
        ? "Offline copy unavailable. Reconnect and reopen to retry."
        : "Offline copy not ready yet.";
  state.textContent = `${connection} · ${copy} Plans stay on this device; no automatic sync.`;
  button.hidden = installed();
  nativeButton.hidden = !installPrompt;
}
button.onclick = () => {
  opener = document.activeElement;
  $("install-message").textContent = "";
  renderState();
  dialog.showModal();
};
$("install-close").onclick = () => dialog.close();
dialog.addEventListener("close", () => opener?.isConnected && opener.focus());
dialog.addEventListener("keydown", (event) => {
  if (event.key !== "Tab") return;
  const buttons = [...dialog.querySelectorAll("button:not([disabled])")].filter(
    (b) => b.getClientRects().length,
  );
  if (!buttons.length) return;
  event.preventDefault();
  const index = buttons.indexOf(document.activeElement);
  buttons[
    (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length
  ].focus();
});
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  renderState();
});
nativeButton.onclick = async () => {
  const prompt = installPrompt;
  if (!prompt) return;
  installPrompt = null;
  nativeButton.disabled = true;
  try {
    await prompt.prompt();
    const choice = await prompt.userChoice;
    $("install-message").textContent =
      choice.outcome === "accepted"
        ? "Installation requested. Open your new home-screen icon when available."
        : "You can install later or use the browser menu below.";
  } catch {
    $("install-message").textContent =
      "Use the browser menu instructions below.";
  } finally {
    nativeButton.disabled = false;
    renderState();
  }
};
window.addEventListener("appinstalled", () => {
  installationObserved = true;
  installPrompt = null;
  button.hidden = true;
  nativeButton.hidden = true;
  dialog.close();
});
for (const event of ["online", "offline"])
  window.addEventListener(event, renderState);
if ("serviceWorker" in navigator)
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "PTP_SHELL_UNAVAILABLE") {
      offlineReady = false;
      failure = true;
      renderState();
    }
  });
matchMedia("(display-mode: standalone)").addEventListener(
  "change",
  renderState,
);
renderState();
if (
  "serviceWorker" in navigator &&
  isSecureContext &&
  document.querySelector('meta[name="planner-offline-shell"]')?.content ===
    "ready"
) {
  const base = new URL("./", import.meta.url);
  navigator.serviceWorker
    .register(new URL("sw.js", base), {
      scope: base.pathname,
      updateViaCache: "none",
    })
    .then((reg) => {
      const watch = () => {
        updateReady = !!reg.waiting && !!reg.active;
        renderState();
      };
      watch();
      const track = () => {
        const worker = reg.installing;
        const change = () => {
          if (worker.state === "installed") {
            updateReady = !!reg.active && reg.active !== worker;
            renderState();
          } else watch();
          if (worker.state === "redundant" && !reg.active) {
            failure = true;
            renderState();
          }
        };
        worker?.addEventListener("statechange", () => {
          change();
          // Waiting/active references may update after the statechange event.
          setTimeout(watch, 0);
        });
        if (worker) change();
      };
      track();
      reg.addEventListener("updatefound", track);
      window.addEventListener("pageshow", watch);
      return navigator.serviceWorker.ready;
    })
    .then(async (reg) => {
      offlineReady = await new Promise((resolve) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => {
          channel.port1.close();
          resolve(false);
        }, 3000);
        channel.port1.onmessage = (event) => {
          clearTimeout(timer);
          channel.port1.close();
          resolve(event.data?.ready === true);
        };
        reg.active.postMessage({ type: "PTP_SHELL_HEALTH" }, [channel.port2]);
      });
      failure = !offlineReady;
      renderState();
    })
    .catch(() => {
      failure = true;
      renderState();
    });
}
