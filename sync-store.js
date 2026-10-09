// Durable, device-local, owner-bound journal. Never stores passwords/Auth tokens.
import { UUID, clone } from "./sync-model.js";
let connection;
async function database() {
  connection ??= new Promise((resolve, reject) => {
    const r = indexedDB.open("personal-trip-planner-sync", 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("accounts", { keyPath: "ownerId" });
      r.result.createObjectStore("control");
    };
    r.onsuccess = () => {
      r.result.onversionchange = () => r.result.close();
      resolve(r.result);
    };
    r.onerror = () =>
      reject(
        Error("Private-sync journal could not open. Keep a local backup."),
      );
  });
  return connection;
}
async function transaction(storeName, mode, action) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode),
      s = tx.objectStore(storeName);
    let result, customError;
    const done = (x) => {
        result = x;
      },
      fail = (e) => {
        customError = e;
        tx.abort();
      };
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () =>
      reject(
        customError ||
          Error("Private-sync journal unavailable/full. Device data is kept."),
      );
    try {
      action(s, done, fail);
    } catch (e) {
      fail(e);
    }
  });
}
export const syncStore = {
  binding: () =>
    transaction("control", "readonly", (s, done) => {
      const r = s.get("binding");
      r.onsuccess = () => done(r.result || null);
    }),
  async bind(ownerId) {
    if (!UUID.test(ownerId)) throw Error("Invalid account identity.");
    return transaction("control", "readwrite", (s, done, fail) => {
      const r = s.get("binding");
      r.onsuccess = () => {
        if (r.result && r.result.ownerId !== ownerId) {
          fail(
            Error(
              "Device plans are bound to another account. Sign back into that account; export/clear locally before changing owner.",
            ),
          );
          return;
        }
        s.put({ ownerId }, "binding");
        done(true);
      };
    });
  },
  load: (ownerId) =>
    transaction("accounts", "readonly", (s, done) => {
      const r = s.get(ownerId);
      r.onsuccess = () => done(r.result || null);
    }),
  save: (state, expectedGeneration) =>
    transaction("accounts", "readwrite", (s, done, fail) => {
      if (!UUID.test(state.ownerId)) throw Error("Invalid journal owner.");
      const r = s.get(state.ownerId);
      r.onsuccess = () => {
        if ((r.result?.generation ?? 0) !== expectedGeneration) {
          const e = Error(
            "Sync journal changed in another tab. Reload before continuing.",
          );
          e.code = "another-tab";
          fail(e);
          return;
        }
        const saved = clone({ ...state, generation: expectedGeneration + 1 });
        s.put(saved);
        done(saved);
      };
    }),
};
