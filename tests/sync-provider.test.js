// Exercises the pinned real SDK against local fetch stubs; no real Auth accounts.
import test from "node:test";
import assert from "node:assert/strict";
import { createProvider } from "../sync-provider.js";
import { emptyDocument, PROJECT_URL } from "../sync-model.js";
const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222";
const config = {
  authEnabled: true,
  enabled: true,
  policiesVerified: true,
  projectUrl: PROJECT_URL,
  publishableKey: "sb_publishable_fictional_mock_only",
};
const storage = () => {
  const map = new Map();
  return {
    map,
    getItem: (k) => map.get(k) || null,
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
};
const jwt = (id) =>
  Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url") +
  "." +
  Buffer.from(
    JSON.stringify({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url") +
  ".fictional_invalid_signature";
const authUser = (id) => ({
  id,
  email: (id === A ? "a" : "b") + "@example.test",
  email_confirmed_at: "2026-10-09T00:00:00Z",
  is_anonymous: false,
});
test("every data write uses the exact server-verified owner token across account-switch races; session-only removes remembered tokens", async () => {
  const original = {
    fetch: globalThis.fetch,
    location: globalThis.location,
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
  };
  globalThis.location = {
    pathname: "/Trip-Planner-/",
    href: "https://fictional.example/Trip-Planner-/",
  };
  globalThis.localStorage = storage();
  globalThis.sessionStorage = storage();
  const key =
    "personal-trip-planner.auth." + encodeURIComponent(location.pathname);
  localStorage.setItem(key, "old fictional remembered login");
  const tokens = { [A]: jwt(A), [B]: jwt(B) },
    requests = [];
  let logoutFailure = false;
  let hold = false,
    release,
    heldResolve,
    held;
  const waitForOwner = () => {
    hold = true;
    held = new Promise((r) => (heldResolve = r));
    return held;
  };
  globalThis.fetch = async (input, options) => {
    const url = new URL(input),
      headers = new Headers(options.headers),
      authorization = headers.get("authorization"),
      body = typeof options.body === "string" ? JSON.parse(options.body) : {};
    assert.equal(url.origin, PROJECT_URL);
    assert.equal(options.cache, "no-store");
    assert.equal(options.credentials, "omit");
    assert.equal(options.referrerPolicy, "no-referrer");
    assert.equal(options.redirect, "error");
    const owner = authorization === "Bearer " + tokens[A] ? A : B;
    if (url.pathname.endsWith("/token")) {
      const id = body.email.startsWith("b") ? B : A;
      return Response.json({
        access_token: tokens[id],
        refresh_token: "fictional invalid refresh token",
        token_type: "bearer",
        expires_in: 3600,
        user: authUser(id),
      });
    }
    if (url.pathname.endsWith("/user")) {
      if (hold && owner === A) {
        hold = false;
        heldResolve();
        await new Promise((r) => (release = r));
      }
      return Response.json(authUser(owner));
    }
    if (url.pathname.endsWith("/logout"))
      return logoutFailure
        ? Response.json(
            { message: "Fictional logout failure" },
            { status: 500 },
          )
        : new Response(null, { status: 204 });
    requests.push({ path: url.pathname, owner, body });
    if (url.pathname.endsWith("/rpc/commit_document")) {
      assert.equal(headers.get("content-profile"), "planner_api");
      assert.deepEqual(Object.keys(body).sort(), [
        "p_expected_revision",
        "p_files",
        "p_planner",
      ]);
      return Response.json({ revision: "1" });
    }
    if (url.pathname.endsWith("/rpc/reserve_file_object"))
      return Response.json(owner + "/" + body.p_object_id);
    if (url.pathname.includes("/storage/v1/object/"))
      return Response.json({ Key: "fictional" });
    throw Error("Unexpected mock endpoint");
  };
  let provider;
  try {
    provider = await createProvider(config);
    assert.equal(localStorage.getItem(key), null);
    await provider.signIn("a@example.test", "Fictional test password");
    assert.equal(await provider.commit(A, "0", emptyDocument()), "1");
    assert.equal(requests.at(-1).owner, A);
    const file = {
      objectId: "33333333-3333-4333-8333-333333333333",
      type: "image/png",
      size: 8,
    };
    await provider.reserve(A, file);
    await provider.upload(
      A,
      file,
      new Blob(["fictional"], { type: file.type }),
    );
    assert.equal(requests.at(-1).owner, A);
    requests.length = 0;
    for (const operation of ["commit", "reserve", "upload"]) {
      await provider.signIn("a@example.test", "Fictional test password");
      assert(sessionStorage.getItem(key));
      assert.equal(localStorage.getItem(key), null);
      const waiting = waitForOwner(),
        file = {
          objectId: "33333333-3333-4333-8333-333333333333",
          type: "image/png",
          size: 8,
        };
      const pending = (
        operation === "commit"
          ? provider.commit(A, "0", emptyDocument())
          : operation === "reserve"
            ? provider.reserve(A, file)
            : provider.upload(
                A,
                file,
                new Blob(["fictional"], { type: file.type }),
              )
      ).catch((error) => error);
      await waiting;
      await provider.signIn("b@example.test", "Fictional test password");
      release();
      const result = await pending;
      assert.equal(
        result.code,
        "paused",
        operation + " must reject stale authorization before data transmission",
      );
      assert.equal(requests.length, 0);
    }
    await assert.rejects(
      provider.commit(A, "0", emptyDocument()),
      (e) => e.code === "owner",
    );
    await provider.signIn("a@example.test", "Fictional test password");
    const waiting = waitForOwner(),
      saving = provider.commit(A, "0", emptyDocument()).catch((e) => e);
    await waiting;
    await provider.signOut();
    release();
    assert.equal((await saving).code, "paused");
    assert.equal(requests.length, 0);
    assert.equal(localStorage.getItem(key), null);
    assert.equal(sessionStorage.getItem(key), null);
    await provider.signIn("a@example.test", "Fictional test password");
    logoutFailure = true;
    await assert.rejects(provider.signOut());
    assert.equal(localStorage.getItem(key), null);
    assert.equal(sessionStorage.getItem(key), null);
    await assert.rejects(provider.commit(A, "0", emptyDocument()));
  } finally {
    provider?.close();
    Object.assign(globalThis, original);
  }
});

test("Auth-only mode verifies accounts but refuses every planner and Storage operation before a data request, including after config mutation", async () => {
  const original = {
    fetch: globalThis.fetch,
    location: globalThis.location,
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
  };
  globalThis.location = { href: "https://fictional.example/Trip-Planner-/" };
  globalThis.localStorage = storage();
  globalThis.sessionStorage = storage();
  const requests = [],
    token = jwt(A);
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    requests.push(url.pathname);
    assert(
      url.pathname.startsWith("/auth/v1/"),
      "data endpoint must never be reached",
    );
    if (url.pathname.endsWith("/token"))
      return Response.json({
        access_token: token,
        refresh_token: "fictional invalid refresh token",
        expires_in: 3600,
        token_type: "bearer",
        user: authUser(A),
      });
    if (url.pathname.endsWith("/user")) return Response.json(authUser(A));
    if (
      url.pathname.endsWith("/signup") ||
      url.pathname.endsWith("/resend") ||
      url.pathname.endsWith("/recover")
    ) {
      const body = JSON.parse(options.body);
      assert.equal(body.email, "a@example.test");
      assert.equal(url.searchParams.get("redirect_to"), location.href);
      return Response.json({});
    }
    if (url.pathname.endsWith("/logout"))
      return new Response(null, { status: 204 });
    throw Error("Unexpected fictional Auth endpoint");
  };
  let provider;
  try {
    const authOnly = { ...config, enabled: false, policiesVerified: false };
    provider = await createProvider(authOnly);
    await provider.signUp("a@example.test", "Fictional test password");
    await provider.resend("a@example.test");
    await provider.recover("a@example.test");
    assert.deepEqual(
      await provider.signIn("a@example.test", "Fictional test password"),
      { id: A, email: "a@example.test" },
    );
    assert.deepEqual(await provider.user(), { id: A, email: "a@example.test" });
    authOnly.enabled = authOnly.policiesVerified = true;
    const file = {
      objectId: "33333333-3333-4333-8333-333333333333",
      type: "image/png",
      size: 8,
    };
    const before = requests.length;
    for (const operation of [
      () => provider.assertOwner(A),
      () => provider.read(A),
      () => provider.commit(A, "0", emptyDocument()),
      () => provider.reserve(A, file),
      () => provider.upload(A, file, new Blob(["fictional"])),
      () => provider.download(A, file),
      () => provider.listObjects(A),
      () => provider.remove(A, file.objectId),
      () => provider.release(A, file.objectId),
    ])
      await assert.rejects(operation(), (e) => e.code === "release-gate");
    assert.equal(requests.length, before);
    await provider.signOut();
  } finally {
    provider?.close();
    Object.assign(globalThis, original);
  }
});
