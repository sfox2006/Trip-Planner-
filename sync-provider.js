// Supabase adapter. Its only caller is the explicitly enabled/private-sync UI.
import { PROJECT_URL, BUCKET, UUID, checkDocument } from "./sync-model.js";
export const appScope = (href = location.href) => new URL("./", href).pathname;
export function configurationShape(config) {
  return Boolean(
    config &&
    typeof config === "object" &&
    !Array.isArray(config) &&
    Object.keys(config).length === 5 &&
    [
      "authEnabled",
      "enabled",
      "policiesVerified",
      "projectUrl",
      "publishableKey",
    ].every((key) => Object.hasOwn(config, key)),
  );
}
export function authConfigurationReady(config) {
  return (
    configurationShape(config) &&
    config.authEnabled === true &&
    typeof config.enabled === "boolean" &&
    config.policiesVerified === config.enabled &&
    config.projectUrl === PROJECT_URL &&
    typeof config.publishableKey === "string" &&
    /^sb_publishable_[A-Za-z0-9_-]{12,}$/.test(config.publishableKey)
  );
}
export function configurationReady(config) {
  return authConfigurationReady(config) && config.enabled === true;
}
export function takeAuthCallback(
  locationObject = location,
  historyObject = history,
) {
  const url = new URL(locationObject.href),
    code = url.searchParams.get("code"),
    flowId = url.searchParams.get("sb_flow_id");
  const failed =
    url.searchParams.has("error") || url.searchParams.has("error_code");
  let changed = false;
  for (const key of [
    "code",
    "sb_flow_id",
    "error",
    "error_code",
    "error_description",
    "type",
    "access_token",
    "refresh_token",
    "token_hash",
  ])
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  const fragment = new URLSearchParams(url.hash.replace(/^#\??/, ""));
  if (
    [
      "access_token",
      "refresh_token",
      "token_hash",
      "code",
      "error",
      "error_code",
      "error_description",
    ].some((key) => fragment.has(key))
  ) {
    url.hash = "";
    changed = true;
  }
  if (changed)
    historyObject.replaceState(null, "", url.pathname + url.search + url.hash);
  return {
    code:
      typeof code === "string" && code.length > 0 && code.length <= 2048
        ? code
        : null,
    flowId: flowId && UUID.test(flowId) ? flowId : null,
    failed,
  };
}
function checked(result) {
  if (result.error) {
    const error = Error("Private sync request failed. Device data is kept.");
    error.code = String(
      result.error.code ||
        result.error.status ||
        result.error.statusCode ||
        "network",
    );
    throw error;
  }
  return result.data;
}
export async function createProvider(
  config,
  { remember = false, scope = appScope() } = {},
) {
  if (!authConfigurationReady(config))
    throw Error("Account sign-in is not configured.");
  config = Object.freeze({ ...config });
  const syncReady = configurationReady(config);
  const requireSync = () => {
    if (!syncReady) {
      const error = Error(
        "Private sync is awaiting live access tests. Plans stay on this device.",
      );
      error.code = "release-gate";
      throw error;
    }
  };
  const { createClient } = await import("./vendor/supabase.mjs");
  const key = "personal-trip-planner.auth." + encodeURIComponent(scope);
  let closed = false,
    authGeneration = 0,
    signingOut = false;
  // Choosing session-only storage also removes a remembered login on this path.
  (remember ? sessionStorage : localStorage).removeItem(key);
  const activeRequests = new Set(),
    listeners = new Set();
  const storage = {
    getItem(name) {
      if (name.endsWith("-code-verifier")) {
        const raw = localStorage.getItem(name);
        if (!raw) return null;
        try {
          const saved = JSON.parse(raw);
          if (typeof saved.value === "string" && saved.expiresAt > Date.now())
            return saved.value;
        } catch {}
        localStorage.removeItem(name);
        return null;
      }
      return (remember ? localStorage : sessionStorage).getItem(name);
    },
    setItem(name, value) {
      if (signingOut && !name.endsWith("-code-verifier")) return;
      if (name.endsWith("-code-verifier"))
        localStorage.setItem(
          name,
          JSON.stringify({ value, expiresAt: Date.now() + 60 * 60 * 1000 }),
        );
      else (remember ? localStorage : sessionStorage).setItem(name, value);
    },
    removeItem(name) {
      if (name.endsWith("-code-verifier")) localStorage.removeItem(name);
      else (remember ? localStorage : sessionStorage).removeItem(name);
    },
  };
  const guardedFetch = async (input, options = {}) => {
    if (closed) throw Error("Private-sync session is closed.");
    const requestURL = new URL(
      typeof input === "string" ? input : input.url || String(input),
    );
    if (
      requestURL.origin !== PROJECT_URL ||
      !/^\/(auth|rest|storage)\/v1\//.test(requestURL.pathname)
    )
      throw Error("Unexpected private-sync endpoint blocked.");
    if (!requestURL.pathname.startsWith("/auth/v1/")) requireSync();
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), 30000);
    const abort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    activeRequests.add(controller);
    try {
      const response = await fetch(input, {
        ...options,
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      // Track/abort through body consumption, including slow Auth responses.
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 16 * 1024 * 1024)
        throw Error("Private-sync response exceeded the safe size limit.");
      return new Response(
        [204, 205, 304].includes(response.status) ? null : bytes,
        {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        },
      );
    } finally {
      clearTimeout(timeout);
      activeRequests.delete(controller);
      options.signal?.removeEventListener("abort", abort);
    }
  };
  const client = createClient(PROJECT_URL, config.publishableKey, {
    db: { schema: "planner_api" },
    auth: {
      storageKey: key,
      storage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: "pkce",
      debug: false,
    },
    global: { fetch: guardedFetch },
  });
  let authIdentity =
    checked(await client.auth.getSession())?.session?.user?.id || null;
  const stale = () => {
    const e = Error("Sign-in changed or sync was paused. Device data is kept.");
    e.code = "paused";
    return e;
  };
  const subscription = client.auth.onAuthStateChange((event, session) => {
    const next = session?.user?.id || null;
    if (event === "SIGNED_OUT" || next !== authIdentity) {
      authGeneration++;
      authIdentity = next;
    }
    if (event === "SIGNED_IN") signingOut = false;
    // No SDK calls/await within the Auth lock callback; no tokens enter UI/journal.
    setTimeout(() => {
      for (const callback of listeners) callback(event);
    }, 0);
  }).data.subscription;
  const verified = async (token) => {
    const data = checked(await client.auth.getUser(token)),
      u = data?.user;
    if (
      !u ||
      !UUID.test(u.id) ||
      !u.email_confirmed_at ||
      u.is_anonymous ||
      !u.email
    ) {
      const error = Error("Sign in with your confirmed individual account.");
      error.code = "42501";
      throw error;
    }
    return { id: u.id, email: u.email };
  };
  const authorized = async (owner) => {
    const generation = authGeneration;
    if (closed || signingOut) throw stale();
    const session = checked(await client.auth.getSession())?.session;
    if (!session?.access_token) {
      const e = Error("Sign in with your confirmed individual account.");
      e.code = "42501";
      throw e;
    }
    // Verify the exact JWT used for this request, then freeze its authorization.
    // An account switch cannot make an A-owner payload use a later B token.
    const token = session.access_token,
      u = await verified(token);
    if (
      closed ||
      signingOut ||
      generation !== authGeneration ||
      authIdentity !== u.id
    )
      throw stale();
    if (owner && u.id !== owner) {
      const e = Error(
        "Account changed. Device data was not sent to another owner.",
      );
      e.code = "owner";
      throw e;
    }
    return {
      user: u,
      client: createClient(PROJECT_URL, config.publishableKey, {
        accessToken: async () => token,
        db: { schema: "planner_api" },
        global: {
          fetch: (...args) => {
            if (closed || signingOut || generation !== authGeneration)
              throw stale();
            return guardedFetch(...args);
          },
        },
      }),
    };
  };
  const user = async () => (await authorized()).user;
  const assertOwner = async (owner) => {
    requireSync();
    return (await authorized(owner)).user;
  };
  const rpc = async (owner, name, args) => {
    requireSync();
    const authorizedClient = (await authorized(owner)).client;
    return checked(
      await authorizedClient.schema("planner_api").rpc(name, args),
    );
  };
  const bucket = async (owner) => {
    requireSync();
    return (await authorized(owner)).client.storage.from(BUCKET);
  };
  const path = (owner, objectId) => {
    if (!UUID.test(owner) || !UUID.test(objectId))
      throw Error("Invalid private object identity.");
    return owner + "/" + objectId;
  };
  const redirect = new URL("./", location.href).href;
  return {
    user,
    assertOwner,
    onAuthChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    async signIn(email, password) {
      signingOut = false;
      checked(await client.auth.signInWithPassword({ email, password }));
      await client.auth.startAutoRefresh();
      return user();
    },
    async signUp(email, password) {
      checked(
        await client.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: redirect },
        }),
      );
    },
    async resend(email) {
      checked(
        await client.auth.resend({
          type: "signup",
          email,
          options: { emailRedirectTo: redirect },
        }),
      );
    },
    async recover(email) {
      checked(
        await client.auth.resetPasswordForEmail(email, {
          redirectTo: redirect,
        }),
      );
    },
    async updatePassword(password) {
      checked(await client.auth.updateUser({ password }));
      return user();
    },
    async callback({ code, flowId }) {
      signingOut = false;
      const data = checked(
        await client.auth.exchangeCodeForSession(
          code,
          flowId ? { flowId } : undefined,
        ),
      );
      await client.auth.startAutoRefresh();
      return { recovery: data.redirectType === "recovery", user: await user() };
    },
    async signOut() {
      authGeneration++;
      signingOut = true;
      for (const request of activeRequests) request.abort();
      try {
        checked(await client.auth.signOut({ scope: "local" }));
      } finally {
        await client.auth.stopAutoRefresh();
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
        storage.removeItem(key + "-code-verifier");
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const name = localStorage.key(i);
          if (name?.startsWith(key + "-") && name.endsWith("-code-verifier"))
            localStorage.removeItem(name);
        }
      }
    },
    async read(owner) {
      return checkDocument(await rpc(owner, "read_document"));
    },
    async commit(owner, expected, document) {
      const out = await rpc(owner, "commit_document", {
        p_expected_revision: expected,
        p_planner: document.planner,
        p_files: document.files,
      });
      if (
        typeof out?.revision !== "string" ||
        !/^([1-9][0-9]{0,18})$/.test(out.revision)
      )
        throw Error("Invalid save acknowledgement. Keep local edits.");
      return out.revision;
    },
    async reserve(owner, file) {
      const result = await rpc(owner, "reserve_file_object", {
        p_object_id: file.objectId,
        p_bytes: file.size,
        p_mime_type: file.type,
      });
      if (result !== path(owner, file.objectId))
        throw Error("Unexpected reservation owner/path.");
    },
    async upload(owner, file, blob) {
      checked(
        await (
          await bucket(owner)
        ).upload(path(owner, file.objectId), blob, {
          contentType: file.type,
          cacheControl: "0",
          upsert: false,
        }),
      );
    },
    async download(owner, file) {
      const blob = checked(
        await (await bucket(owner)).download(path(owner, file.objectId)),
      );
      if (!(blob instanceof Blob))
        throw Error("Private file bytes are unavailable.");
      return blob;
    },
    async listObjects(owner) {
      const list = await rpc(owner, "list_file_objects");
      if (
        !Array.isArray(list) ||
        list.length > 100 ||
        list.some(
          (r) =>
            !UUID.test(r.objectId) ||
            !Number.isSafeInteger(r.size) ||
            r.size <= 0 ||
            r.size > 5242880 ||
            typeof r.type !== "string" ||
            typeof r.createdAt !== "string",
        )
      )
        throw Error("Invalid recovery reservation list.");
      return list;
    },
    async remove(owner, objectId) {
      checked(await (await bucket(owner)).remove([path(owner, objectId)]));
    },
    async release(owner, objectId) {
      if (
        (await rpc(owner, "release_file_object", { p_object_id: objectId })) !==
        true
      )
        throw Error("Private file quota release was not acknowledged.");
    },
    close() {
      authGeneration++;
      closed = true;
      subscription.unsubscribe();
      client.auth.stopAutoRefresh();
      for (const r of activeRequests) r.abort();
      listeners.clear();
    },
  };
}
