import { cloudConfig } from "./cloud-config.js";
import {
  authConfigurationReady,
  configurationReady,
  createProvider,
  takeAuthCallback,
  appScope,
} from "./sync-provider.js";
import { SyncEngine } from "./sync-engine.js";
import { syncStore } from "./sync-store.js";
import { plannerBridge } from "./app.js";
import { stable } from "./sync-model.js";
const $ = (id) => document.getElementById(id);
const node = (tag, text) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  return e;
};
function localDownload(text) {
  const url = URL.createObjectURL(
      new Blob([text], { type: "application/json" }),
    ),
    a = node("a");
  a.href = url;
  a.download = "personal-trip-planner-sync-recovery.json";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function initSyncUI({
  configured = authConfigurationReady(cloudConfig),
  syncConfigured = configurationReady(cloudConfig),
  providerFactory = (options) => createProvider(cloudConfig, options),
  store = syncStore,
  bridge = plannerBridge,
  online = () => navigator.onLine,
} = {}) {
  const callback = takeAuthCallback(),
    dialog = $("sync-dialog"),
    scope = appScope(),
    rememberKey =
      "personal-trip-planner.auth.remember." + encodeURIComponent(scope);
  let provider = null,
    engine = null,
    currentUser = null,
    recoveryMode = false,
    busy = 0,
    opener = null,
    conflictKey = "",
    remember = false,
    disposed = false,
    poll;
  try {
    remember = localStorage.getItem(rememberKey) === "true";
  } catch {}
  $("sync-remember").checked = remember;
  if (configured && syncConfigured) {
    if ($("welcome-privacy"))
      $("welcome-privacy").textContent =
        "Save trips on this device, or confirm an individual account and explicitly connect private sync.";
    $("backup-storage-model").textContent =
      "Trips save in this browser on this device. Nothing is uploaded until you confirm an individual account and connect this device to private sync. Connected copies sync when online; check save status. Provider administrators can access cloud data; it is not end-to-end encrypted. This browser’s storage is also unencrypted and other people using it can see your plans.";
  }
  const signInMessage = syncConfigured
    ? "Sign in with your confirmed individual account to connect private sync."
    : "Sign in with your confirmed individual account. Private sync is awaiting live access tests; plans stay on this device.";
  if (configured && !syncConfigured) {
    $("welcome-privacy").textContent =
      "Save trips on this device. Account sign-in is available for testing; private sync is awaiting live access tests.";
    $("backup-storage-model").textContent =
      "Trips and files save in this browser on this device. Account sign-in is available for testing; private sync remains blocked and no trip data is uploaded. Other people using this browser can see your plans.";
    $("sync-disabled").textContent =
      "Account sign-in is available. Private sync is awaiting live access tests; no trips or files are sent.";
  }
  function render() {
    const state = engine?.state,
      joined = Boolean(
        currentUser && engine?.owner === currentUser.id && state?.joined,
      ),
      status = engine?.status || {
        text: configured
          ? signInMessage
          : "Cloud sync is not configured. Plans stay on this device.",
      };
    $("sync-state").textContent = status.text;
    $("sync-message").textContent = status.text;
    $("sync-state").dataset.connected = String(joined);
    document.dispatchEvent(new Event("ptp-sync-state"));
    $("sync-disabled").hidden = configured && syncConfigured;
    $("sync-auth").hidden = !configured || Boolean(currentUser);
    $("sync-account").hidden = !currentUser;
    $("sync-identity").textContent = currentUser
      ? "Signed in as " + currentUser.email
      : "";
    $("sync-join").hidden = !syncConfigured || joined || recoveryMode;
    $("sync-connected").hidden = !syncConfigured || !joined || recoveryMode;
    $("sync-new-password").hidden = !recoveryMode;
    $("sync-repair").hidden = status.kind !== "file-recovery";
    $("sync-recovery").hidden =
      !state ||
      !(
        state.recovery ||
        state.conflict ||
        state.candidate ||
        status.kind === "error" ||
        status.kind === "permission" ||
        status.kind === "file-recovery"
      );
    $("sync-recovery-restore").hidden = !state?.recovery || !engine?.owner;
    $("sync-conflicts").hidden = !state?.conflict;
    if (state?.conflict) {
      const key = stable({
        items: state.conflict.items,
        revision: state.conflict.remote.revision,
      });
      if (key !== conflictKey) {
        conflictKey = key;
        $("sync-conflict-choices").replaceChildren();
        for (const item of state.conflict.items) {
          const label = node("label", item.name),
            select = node("select");
          select.required = true;
          select.dataset.tripId = item.tripId;
          for (const [value, text] of [
            ["", "Choose how to keep this trip"],
            ["cloud", "Keep the cloud version"],
            ...(item.canCopy
              ? [["copy", "Keep cloud and a separate device copy"]]
              : []),
          ]) {
            const option = node("option", text);
            option.value = value;
            select.append(option);
          }
          label.append(select);
          $("sync-conflict-choices").append(label);
        }
      }
    } else conflictKey = "";
    for (const control of dialog.querySelectorAll("button,input,select"))
      control.disabled = busy > 0 && control.id !== "sync-close";
    for (const checkbox of $("sync-cleanup-list").querySelectorAll(
      "input[data-protected=true]",
    ))
      checkbox.disabled = true;
  }
  async function action(fn) {
    busy++;
    render();
    try {
      return await fn();
    } catch (error) {
      if (engine?.state?.recovery)
        engine.setStatus(
          "recovery",
          "A device refresh failed. Original data is saved; download or restore recovery before continuing.",
        );
      else if (
        engine &&
        !["conflict", "file-recovery", "recovery", "pending"].includes(
          engine.status.kind,
        )
      )
        engine.setStatus(
          error.code === "owner" || error.code === "42501"
            ? "permission"
            : "error",
          error.message ||
            "Private sync could not finish. Device data is kept.",
        );
      else if (!engine)
        $("sync-message").textContent =
          "Sign-in is unavailable. Device data is kept.";
      return undefined;
    } finally {
      busy--;
      render();
    }
  }
  const syncAction = (fn) =>
    action(async () => {
      if (!syncConfigured)
        throw Error(
          "Private sync is awaiting live access tests. Plans stay on this device.",
        );
      return fn();
    });
  const lock = async (fn) => {
    if (!navigator.locks) return fn();
    return navigator.locks.request(
      "personal-trip-planner-sync:" + scope,
      { ifAvailable: true },
      async (held) => {
        if (!held) {
          engine?.setStatus(
            "pending",
            "Another planner window is syncing. Close it or retry here; device edits are kept.",
          );
          return;
        }
        return fn();
      },
    );
  };
  function makeEngine() {
    engine = new SyncEngine({
      provider,
      store,
      bridge,
      online,
      lock,
      cleanupAllowed: () => Boolean(navigator.locks),
      onStatus: render,
    });
  }
  async function ensureProvider(nextRemember = remember) {
    if (provider && nextRemember === remember) return provider;
    provider?.close();
    remember = nextRemember;
    try {
      localStorage.setItem(rememberKey, String(remember));
    } catch {}
    provider = await providerFactory({ remember, scope });
    makeEngine();
    const subscribedProvider = provider,
      subscribedEngine = engine;
    provider.onAuthChange((event) => {
      // Listener receives only event names, never tokens. Defer SDK work again.
      setTimeout(() => {
        if (
          disposed ||
          provider !== subscribedProvider ||
          engine !== subscribedEngine
        )
          return;
        if (event === "SIGNED_OUT") {
          currentUser = null;
          recoveryMode = false;
          engine.pause();
          render();
        } else if (event === "PASSWORD_RECOVERY") {
          recoveryMode = true;
          void action(() => refreshUser(false));
        } else if (event === "SIGNED_IN" || event === "INITIAL_SESSION") {
          void action(async () => {
            const next = await provider.user();
            if (currentUser && currentUser.id !== next.id) {
              engine.pause();
              currentUser = null;
              recoveryMode = false;
            }
            if (!currentUser) await refreshUser(false);
          });
        }
      }, 0);
    });
    return provider;
  }
  async function refreshUser(autoSync = true) {
    const user = await provider.user();
    currentUser = user;
    if (!syncConfigured) {
      engine.setStatus(
        "auth-only",
        "Account verified. Private sync is awaiting live access tests. Plans stay on this device.",
      );
      render();
      return;
    }
    if (recoveryMode) {
      render();
      return;
    }
    const attached = await engine.attach(user.id);
    render();
    if (attached && autoSync) await engine.syncNow();
    if (!attached) {
      const counts = await engine.preview(user.id);
      $("sync-join-counts").textContent =
        `${counts.deviceTrips} device trip(s) · ${counts.cloudTrips} account trip(s) · ${counts.cloudFiles} account file(s). Connect to merge them. Exact copies imported with fresh IDs are kept once; edited trips remain separate.`;
    }
  }
  $("sync-open").onclick = () => {
    opener = document.activeElement;
    dialog.showModal();
  };
  $("sync-close").onclick = () => dialog.close();
  dialog.addEventListener("close", () => {
    if (opener?.isConnected) opener.focus();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const controls = [
        ...dialog.querySelectorAll("button,input,select,a[href]"),
      ].filter((e) => !e.disabled && e.getClientRects().length),
      first = controls[0],
      last = controls.at(-1);
    if (!first) return;
    if (event.shiftKey && document.activeElement === first) {
      last.focus();
      event.preventDefault();
    } else if (!event.shiftKey && document.activeElement === last) {
      first.focus();
      event.preventDefault();
    }
  });
  $("sync-auth").onsubmit = (event) => {
    event.preventDefault();
    const mode = event.submitter?.value || "signin",
      email = $("sync-email").value.trim(),
      password = $("sync-password").value,
      nextRemember = $("sync-remember").checked;
    $("sync-password").value = "";
    void action(async () => {
      if (mode === "signup" && password.length < 8)
        throw Error(
          "Use at least eight characters for a new account password.",
        );
      await ensureProvider(nextRemember);
      if (mode === "signup") {
        await provider.signUp(email, password);
        engine.setStatus(
          "signed-out",
          "Check your eligible email to confirm the account, then sign in. If delivery is unavailable, keep confirmation enabled and check the approved mail setup.",
        );
      } else {
        await provider.signIn(email, password);
        await refreshUser();
      }
    });
  };
  const emailAction = (method) => {
    const input = $("sync-email");
    if (!input.reportValidity()) return;
    void action(async () => {
      await ensureProvider($("sync-remember").checked);
      await provider[method](input.value.trim());
      engine.setStatus(
        "signed-out",
        "If this address is eligible, check your email and open the link in the browser that requested it. Sign in after confirmation; passwords remain user-entered.",
      );
    });
  };
  $("sync-resend").onclick = () => emailAction("resend");
  $("sync-recover").onclick = () => emailAction("recover");
  $("sync-new-password").onsubmit = (event) => {
    event.preventDefault();
    const password = $("sync-new-password-value").value;
    $("sync-new-password-value").value = "";
    void action(async () => {
      await provider.updatePassword(password);
      recoveryMode = false;
      await refreshUser();
    });
  };
  $("sync-connect").onclick = () =>
    void syncAction(async () => {
      if (!currentUser) throw Error("Sign in first.");
      await engine.connect(currentUser.id);
      await engine.syncNow();
    });
  $("sync-now").onclick = () => void syncAction(() => engine.syncNow());
  $("sync-verify").onclick = () =>
    void syncAction(() => engine.syncNow({ verifyFiles: true }));
  $("sync-repair").onclick = () => void syncAction(() => engine.repairFiles());
  $("sync-signout").onclick = () =>
    void action(async () => {
      engine.pause();
      currentUser = null;
      recoveryMode = false;
      $("sync-email").value = "";
      $("sync-password").value = "";
      await provider.signOut();
      render();
    });
  $("sync-conflicts").onsubmit = (event) => {
    event.preventDefault();
    const choices = Object.fromEntries(
      [...$("sync-conflict-choices").querySelectorAll("select")].map((s) => [
        s.dataset.tripId,
        s.value,
      ]),
    );
    void syncAction(async () => {
      await engine.resolve(choices);
      if (!engine.state?.conflict) await engine.syncNow();
    });
  };
  $("sync-recovery-download").onclick = () =>
    void syncAction(async () => localDownload(await engine.recoveryBackup()));
  $("sync-recovery-restore").onclick = () =>
    void syncAction(() => engine.restoreRecovery());
  $("sync-cleanup-open").onclick = () =>
    void syncAction(async () => {
      const reservations = await engine.reservations(),
        state = engine.state,
        used = new Set(
          [
            ...(state.base.files || []),
            ...(state.local.files || []),
            ...(state.candidate?.files || []),
          ].map((f) => f.objectId),
        );
      $("sync-cleanup-list").replaceChildren();
      if (!reservations.length)
        $("sync-cleanup-list").append(
          node("p", "No unfinished or saved file reservations."),
        );
      for (const r of reservations) {
        const staged = state.staging.find(
            (s) => s.file.objectId === r.objectId,
          ),
          inUse = used.has(r.objectId),
          label = node("label"),
          input = node("input");
        input.type = "checkbox";
        input.value = r.objectId;
        input.disabled = inUse;
        input.dataset.protected = String(inUse);
        label.className = "check-label";
        label.append(
          input,
          node(
            "span",
            `${staged?.file.name || "Private upload"} · ${(r.size / 1024).toFixed(1)} KiB${inUse ? " · saved or pending; kept" : ""}`,
          ),
        );
        $("sync-cleanup-list").append(label);
      }
      $("sync-cleanup").hidden = false;
    });
  $("sync-cleanup").onsubmit = (event) => {
    event.preventDefault();
    const ids = [
      ...$("sync-cleanup-list").querySelectorAll(
        "input:checked:not(:disabled)",
      ),
    ].map((e) => e.value);
    if (!ids.length) return;
    void syncAction(async () => {
      const removed = await engine.cleanup(ids);
      $("sync-cleanup").hidden = true;
      engine.setStatus(
        "pending",
        `${removed} unused private upload(s) removed. Saved and pending files were kept.`,
      );
    });
  };
  const captureChanges = () => {
    if (engine?.owner && engine.state?.joined)
      void engine
        .capture()
        .catch((error) =>
          engine.setStatus(
            engine.state?.recovery ? "recovery" : "error",
            error.message,
          ),
        );
  };
  const unsubscribe = bridge.subscribe(captureChanges);
  document.addEventListener("ptp-local-reset", captureChanges);
  const resume = () => {
    if (
      syncConfigured &&
      !disposed &&
      currentUser &&
      engine?.owner &&
      engine.state?.joined &&
      !recoveryMode &&
      !busy &&
      document.visibilityState !== "hidden" &&
      online() &&
      !["permission", "recovery", "conflict", "file-recovery"].includes(
        engine.status.kind,
      )
    )
      void action(() => engine.syncNow());
  };
  window.addEventListener("online", resume);
  document.addEventListener("visibilitychange", resume);
  if (configured) {
    try {
      await ensureProvider();
      if (callback.failed)
        throw Error(
          "This confirmation/recovery link failed. Request a new link in the original browser.",
        );
      if (callback.code) {
        const verified = await provider.callback(callback);
        recoveryMode = verified.recovery;
        currentUser = verified.user;
      }
      await refreshUser();
    } catch (error) {
      if (!currentUser) {
        engine?.setStatus(
          "signed-out",
          callback.code
            ? "The link could not be verified here. It may be expired or opened in a different browser. Sign in after confirmation or request a new recovery link."
            : signInMessage,
        );
      } else
        engine?.setStatus(
          engine.state?.recovery ? "recovery" : "permission",
          error.message,
        );
    }
    if (syncConfigured) poll = setInterval(resume, 60000);
  } else if (callback.code || callback.failed) {
    $("sync-message").textContent =
      "Private sync is not configured; this link was not exchanged. Its parameters were removed. Plans stay on this device.";
  }
  render();
  return {
    get engine() {
      return engine;
    },
    get provider() {
      return provider;
    },
    get user() {
      return currentUser;
    },
    async refresh() {
      return action(() => refreshUser());
    },
    dispose() {
      disposed = true;
      clearInterval(poll);
      unsubscribe();
      document.removeEventListener("ptp-local-reset", captureChanges);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
      provider?.close();
    },
  };
}
void initSyncUI();
