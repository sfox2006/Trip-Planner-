// Device-local binary storage adapter. No uploads, remote URLs or executable file previews.
import { uid, validate, parseBackup, mergeBackup } from "./model.js";
export const MAX_FILE = 5 * 1024 * 1024,
  MAX_TOTAL = 20 * 1024 * 1024,
  MAX_COUNT = 100,
  MAX_BACKUP = 32 * 1024 * 1024;
const types = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
export function filename(raw, type) {
  if (!types[type])
    throw Error("Only PDF, PNG, JPEG, WebP and GIF files are supported.");
  let name = String(raw)
    .normalize("NFKC")
    .replace(/[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>:"|?*]/g, "_")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120);
  if (!name) name = "attachment";
  const ext = "." + types[type];
  if (
    !new RegExp(`\\.${types[type]}$`, "i").test(name) &&
    !(type === "image/jpeg" && /\.jpeg$/i.test(name))
  )
    name = name.slice(0, 120 - ext.length) + ext;
  return name;
}
export async function checkFile(blob) {
  if (!types[blob.type])
    throw Error(
      "Only PDF, PNG, JPEG, WebP and GIF files are supported. HTML and SVG are not accepted.",
    );
  if (!blob.size || blob.size > MAX_FILE)
    throw Error("Each file must be nonempty and no larger than 5 MB.");
  const b = new Uint8Array(await blob.slice(0, 16).arrayBuffer()),
    ascii = String.fromCharCode(...b);
  const signature =
    blob.type === "application/pdf"
      ? ascii.startsWith("%PDF-")
      : blob.type === "image/png"
        ? [137, 80, 78, 71, 13, 10, 26, 10].every((x, i) => b[i] === x)
        : blob.type === "image/jpeg"
          ? b[0] === 255 && b[1] === 216 && b[2] === 255
          : blob.type === "image/gif"
            ? /^GIF8[79]a/.test(ascii)
            : ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP";
  if (!signature) throw Error("File content does not match its stated type.");
  if (
    blob.type !== "application/pdf" &&
    typeof createImageBitmap === "function"
  ) {
    let image;
    try {
      image = await createImageBitmap(blob);
      if (image.width * image.height > 20_000_000)
        throw Error("Images must be no larger than 20 megapixels.");
    } finally {
      image?.close();
    }
  }
  return blob;
}
const references = (planner, r) =>
  planner.trips.some(
    (t) => t.id === r.tripId && t.items.some((i) => i.id === r.planId),
  );
export function ownedFiles(planner, rows) {
  return rows.filter((r) => references(planner, r));
}
let connection;
function db() {
  connection ??= new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(Error("This browser does not support file storage."));
      return;
    }
    const request = indexedDB.open("personal-trip-planner-files", 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("attachments"))
        request.result.createObjectStore("attachments", { keyPath: "id" });
      if (!request.result.objectStoreNames.contains("control"))
        request.result.createObjectStore("control");
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        connection = undefined;
      };
      resolve(request.result);
    };
    request.onerror = () => {
      connection = undefined;
      reject(request.error);
    };
    request.onblocked = () =>
      reject(Error("Close other planner tabs to unlock file storage."));
  });
  return connection;
}
async function transaction(mode, action, stores = "attachments") {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(stores, mode),
      store = tx.objectStore("attachments");
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () =>
      reject(
        result === false
          ? Error(
              "File storage limit reached: at most 100 attachments and 20 MB total. Remove files before adding more.",
            )
          : tx.error || Error("File storage operation was cancelled."),
      );
    tx.onerror = () => {};
    try {
      action(store, (v) => (result = v), tx);
    } catch (e) {
      tx.abort();
      reject(e);
    }
  });
}
export function fileFingerprint(rows) {
  return JSON.stringify(
    rows
      .map((r) => [
        r.id,
        r.tripId,
        r.planId,
        r.name,
        r.type,
        r.size,
        Boolean(r.pending),
      ])
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
}
export const files = {
  projectionMarker: () =>
    transaction(
      "readonly",
      (_s, done, tx) => {
        const r = tx.objectStore("control").get("sync-projection");
        r.onsuccess = () => done(r.result || null);
      },
      ["attachments", "control"],
    ),
  list: () =>
    transaction("readonly", (s, done) => {
      const r = s.getAll();
      r.onsuccess = () => done(r.result);
    }),
  add: (records) =>
    transaction("readwrite", (s, done, tx) => {
      const req = s.getAll();
      req.onsuccess = () => {
        const current = req.result;
        if (
          current.length + records.length > MAX_COUNT ||
          current.reduce((n, r) => n + r.size, 0) +
            records.reduce((n, r) => n + r.size, 0) >
            MAX_TOTAL
        ) {
          done(false);
          tx.abort();
          return;
        }
        for (const r of records)
          s.add({ ...r, pending: true, createdAt: Date.now() });
        done(true);
      };
    }),
  replaceAll: (
    records,
    expectedFingerprint,
    marker = undefined,
    expectedMarker = undefined,
  ) =>
    transaction(
      "readwrite",
      (s, done, tx) => {
        const control = tx.objectStore("control"),
          previousMarker = control.get("sync-projection");
        const req = s.getAll();
        req.onsuccess = () => {
          if (
            fileFingerprint(req.result) !== expectedFingerprint ||
            (expectedMarker !== undefined &&
              (previousMarker.result || null) !== expectedMarker) ||
            records.length > MAX_COUNT ||
            records.reduce((n, r) => n + r.size, 0) > MAX_TOTAL
          ) {
            done(false);
            tx.abort();
            return;
          }
          if (marker !== undefined) {
            if (marker === null) control.delete("sync-projection");
            else control.put(marker, "sync-projection");
          }
          s.clear();
          for (const r of records) s.put({ ...r, pending: false });
          done(true);
        };
      },
      ["attachments", "control"],
    ),
  finalize: (ids) =>
    transaction("readwrite", (s) => {
      for (const id of ids) {
        const req = s.get(id);
        req.onsuccess = () => {
          if (req.result) {
            req.result.pending = false;
            s.put(req.result);
          }
        };
      }
    }),
  rename: (id, name) =>
    transaction("readwrite", (s, done) => {
      const req = s.get(id);
      req.onsuccess = () => {
        if (!req.result) return;
        req.result.name = name;
        s.put(req.result);
      };
    }),
  remove: (ids) =>
    transaction("readwrite", (s) => {
      for (const id of ids) s.delete(id);
    }),
};
export async function makeRecords(fileList, tripId, planId) {
  const rows = [];
  for (const f of fileList) {
    await checkFile(f);
    rows.push({
      id: uid(),
      tripId,
      planId,
      name: filename(f.name, f.type),
      type: f.type,
      size: f.size,
      blob: new Blob([f], { type: f.type }),
    });
  }
  return rows;
}
async function base64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768)
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}
export async function portableBackup(planner, rows) {
  const attachments = [];
  for (const r of ownedFiles(planner, rows))
    attachments.push({
      id: r.id,
      tripId: r.tripId,
      planId: r.planId,
      name: r.name,
      type: r.type,
      size: r.size,
      data: await base64(r.blob),
    });
  return JSON.stringify({
    format: "personal-trip-planner-backup",
    version: 2,
    planner,
    attachments,
  });
}
function object(o, keys) {
  if (
    !o ||
    typeof o !== "object" ||
    Array.isArray(o) ||
    Object.keys(o).some((k) => !keys.includes(k)) ||
    keys.some((k) => !(k in o))
  )
    throw Error("Backup has invalid or unsupported attachment fields.");
}
export async function readPortableBackup(text) {
  if (new TextEncoder().encode(text).length > MAX_BACKUP)
    throw Error("Full backup must be smaller than 32 MB.");
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw Error("This file is not valid JSON.");
  }
  if (envelope?.format === undefined)
    return { planner: parseBackup(text), attachments: [] };
  object(envelope, ["format", "version", "planner", "attachments"]);
  if (
    envelope.format !== "personal-trip-planner-backup" ||
    envelope.version !== 2
  )
    throw Error("Unsupported full-backup format or version.");
  validate(envelope.planner);
  if (
    !Array.isArray(envelope.attachments) ||
    envelope.attachments.length > MAX_COUNT
  )
    throw Error("Backup allows at most 100 attachments.");
  const seen = new Set(),
    rows = [];
  let total = 0;
  for (const r of envelope.attachments) {
    object(r, ["id", "tripId", "planId", "name", "type", "size", "data"]);
    if (
      typeof r.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(r.id) ||
      seen.has(r.id)
    )
      throw Error("Attachment IDs must be valid and unique.");
    seen.add(r.id);
    if (
      typeof r.name !== "string" ||
      r.name.length > 140 ||
      filename(r.name, r.type) !== r.name ||
      !references(envelope.planner, r)
    )
      throw Error("Attachment name or owning plan is invalid.");
    if (
      !Number.isInteger(r.size) ||
      r.size <= 0 ||
      r.size > MAX_FILE ||
      typeof r.data !== "string" ||
      r.data.length > Math.ceil(MAX_FILE / 3) * 4 ||
      r.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(r.data)
    )
      throw Error("Attachment size or binary encoding is invalid.");
    let decoded;
    try {
      decoded = atob(r.data);
    } catch {
      throw Error("Invalid attachment binary encoding.");
    }
    if (decoded.length !== r.size)
      throw Error("Attachment byte count does not match the backup.");
    total += r.size;
    if (total > MAX_TOTAL)
      throw Error("Attachments exceed the 20 MB device limit.");
    const blob = new Blob([Uint8Array.from(decoded, (c) => c.charCodeAt(0))], {
      type: r.type,
    });
    await checkFile(blob);
    rows.push({ ...r, blob });
    delete rows.at(-1).data;
  }
  return { planner: envelope.planner, attachments: rows };
}
export function remapImport(current, incoming) {
  const planner = mergeBackup(current, incoming.planner),
    tripIDs = new Map(),
    planIDs = new Map();
  incoming.planner.trips.forEach((t, index) => {
    const copy = planner.trips[current.trips.length + index];
    tripIDs.set(t.id, copy.id);
    t.items.forEach((i, j) => planIDs.set(i.id, copy.items[j].id));
  });
  return {
    planner,
    attachments: incoming.attachments.map((r) => ({
      ...r,
      id: uid(),
      tripId: tripIDs.get(r.tripId),
      planId: planIDs.get(r.planId),
    })),
  };
}
