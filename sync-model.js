// Pure sync transport/merge rules. No credentials, HTML, URLs or network access.
import { blank, validate, uid } from "./model.js";
import {
  filename,
  remapImport,
  MAX_COUNT,
  MAX_FILE,
  MAX_TOTAL,
} from "./attachments.js";
export const PROJECT_URL = "https://psdfjframcinoryyklxf.supabase.co";
export const BUCKET = "planner-attachments";
export const ID = /^[A-Za-z0-9_-]{1,100}$/;
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const clone = (value) => structuredClone(value);
export function stable(value) {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + stable(value[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
const equal = (a, b) => stable(a) === stable(b);
export function recordMetadata(r) {
  return {
    id: r.id,
    tripId: r.tripId,
    planId: r.planId,
    name: r.name,
    type: r.type,
    size: r.size,
  };
}
export function checkManifests(planner, files) {
  validate(planner);
  if (!Array.isArray(files) || files.length > MAX_COUNT)
    throw Error("Invalid cloud file list.");
  let total = 0;
  const seen = new Set(),
    objects = new Set();
  for (const t of planner.trips) {
    seen.add(t.id);
    for (const key of ["items", "packing", "expenses", "budgets", "links"])
      for (const e of t[key]) seen.add(e.id);
  }
  for (const f of files) {
    if (
      !f ||
      typeof f !== "object" ||
      Array.isArray(f) ||
      Object.keys(f).length !== 9 ||
      ![
        "version",
        "id",
        "tripId",
        "planId",
        "name",
        "type",
        "size",
        "sha256",
        "objectId",
      ].every((k) => Object.hasOwn(f, k)) ||
      f.version !== 1 ||
      typeof f.id !== "string" ||
      !ID.test(f.id) ||
      seen.has(f.id) ||
      typeof f.objectId !== "string" ||
      !UUID.test(f.objectId) ||
      objects.has(f.objectId) ||
      typeof f.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(f.sha256) ||
      !Number.isSafeInteger(f.size) ||
      f.size <= 0 ||
      f.size > MAX_FILE ||
      typeof f.name !== "string" ||
      filename(f.name, f.type) !== f.name ||
      !planner.trips.some(
        (t) => t.id === f.tripId && t.items.some((i) => i.id === f.planId),
      )
    )
      throw Error("Cloud attachment metadata is invalid. Device data is kept.");
    seen.add(f.id);
    objects.add(f.objectId);
    total += f.size;
  }
  if (total > MAX_TOTAL)
    throw Error("Cloud attachments exceed this device’s limit.");
  return files;
}
export function checkDocument(raw) {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).length !== 5 ||
    (raw.updatedAt !== null &&
      (typeof raw.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(raw.updatedAt)))) ||
    Object.keys(raw).some(
      (k) =>
        !["revision", "planner", "files", "updatedAt", "deletedIds"].includes(
          k,
        ),
    ) ||
    typeof raw.revision !== "string" ||
    !/^(0|[1-9][0-9]{0,18})$/.test(raw.revision) ||
    BigInt(raw.revision) > 9223372036854775807n ||
    !Array.isArray(raw.deletedIds) ||
    raw.deletedIds.length > 100000 ||
    raw.deletedIds.some((id) => typeof id !== "string" || !ID.test(id)) ||
    new Set(raw.deletedIds).size !== raw.deletedIds.length
  )
    throw Error("Invalid cloud snapshot. Device data is kept.");
  checkManifests(raw.planner, raw.files);
  const live = new Set(
    raw.planner.trips
      .flatMap((t) => [
        t.id,
        ...["items", "packing", "expenses", "budgets", "links"].flatMap((k) =>
          t[k].map((e) => e.id),
        ),
      ])
      .concat(raw.files.map((f) => f.id)),
  );
  if (raw.deletedIds.some((id) => live.has(id)))
    throw Error(
      "A cloud entity is both live and deleted. Device data is kept.",
    );
  return clone(raw);
}
export const emptyDocument = () => ({
  revision: "0",
  planner: blank(),
  files: [],
  updatedAt: null,
  deletedIds: [],
});
export async function sha256(blob) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export function sameContents(a, b) {
  return equal(a.planner, b.planner) && equal(a.files, b.files);
}
function mergeFields(base, local, remote, mark) {
  const result = {};
  for (const key of new Set([
    ...Object.keys(base || {}),
    ...Object.keys(local || {}),
    ...Object.keys(remote || {}),
  ])) {
    const b = base?.[key],
      l = local?.[key],
      r = remote?.[key];
    if (equal(l, r) || equal(l, b)) result[key] = clone(r);
    else if (equal(r, b)) result[key] = clone(l);
    else {
      mark(key);
      result[key] = clone(r);
    }
  }
  return result;
}
function mergeList(base, local, remote, mark, deleted, files = false) {
  const byId = (a) => new Map(a.map((e) => [e.id, e])),
    b = byId(base),
    l = byId(local),
    r = byId(remote),
    result = [];
  for (const id of new Set([...r.keys(), ...l.keys(), ...b.keys()])) {
    const bv = b.get(id),
      lv = l.get(id),
      rv = r.get(id);
    if (deleted.has(id) && lv) {
      if (!equal(lv, bv)) mark("deleted entity");
      if (rv) result.push(clone(rv));
      continue;
    }
    if (!lv || !rv) {
      if (!bv) {
        if (lv || rv) result.push(clone(lv || rv));
      } else if ((lv && !equal(lv, bv)) || (rv && !equal(rv, bv))) {
        mark("deletion versus edit");
        if (rv) result.push(clone(rv));
      }
      continue;
    }
    if (!bv && !equal(lv, rv)) {
      mark("duplicate ID");
      result.push(clone(rv));
      continue;
    }
    if (files) {
      const pack = (e) => {
        const { type, size, sha256, objectId, ...rest } = e;
        return { ...rest, bytes: { type, size, sha256, objectId } };
      };
      const merged = mergeFields(bv ? pack(bv) : {}, pack(lv), pack(rv), mark),
        { bytes, ...rest } = merged;
      result.push({ ...rest, ...bytes });
    } else result.push(mergeFields(bv, lv, rv, mark));
  }
  return result;
}
// Independent IDs/fields merge automatically. Any competing change is resolved
// per trip: keep cloud, or keep cloud plus a fresh-ID device copy. Never overwrite
// a competing cloud version or resurrect tombstoned IDs silently.
export function mergeDocuments(base, local, remote, choices = {}) {
  const result = { planner: blank(), files: [] },
    conflicts = [],
    deleted = new Set(remote.deletedIds || []);
  const byId = (trips) => new Map(trips.map((t) => [t.id, t])),
    b = byId(base.planner.trips),
    l = byId(local.planner.trips),
    r = byId(remote.planner.trips);
  const owners = (document) =>
    new Map(
      document.planner.trips.flatMap((t) =>
        [
          t.id,
          ...["items", "packing", "expenses", "budgets", "links"].flatMap((k) =>
            t[k].map((e) => e.id),
          ),
          ...document.files.filter((f) => f.tripId === t.id).map((f) => f.id),
        ].map((id) => [id, t.id]),
      ),
    );
  const baseOwners = owners(base),
    remoteOwners = owners(remote),
    localOwners = owners(local);
  for (const id of new Set([...r.keys(), ...l.keys(), ...b.keys()])) {
    const bv = b.get(id),
      lv = l.get(id),
      rv = r.get(id),
      reasons = new Set();
    if (
      [...localOwners].some(
        ([entity, trip]) =>
          trip === id &&
          !baseOwners.has(entity) &&
          remoteOwners.has(entity) &&
          remoteOwners.get(entity) !== id,
      )
    )
      reasons.add("parallel additions reuse an ID across trips");
    const mark = (reason) => reasons.add(reason),
      bf = base.files.filter((f) => f.tripId === id),
      lf = local.files.filter((f) => f.tripId === id),
      rf = remote.files.filter((f) => f.tripId === id);
    let merged;
    if (deleted.has(id) && lv) {
      if (!equal(lv, bv) || !equal(lf, bf)) mark("cloud trip deletion");
      merged = rv ? clone(rv) : null;
    } else if (!lv || !rv) {
      if (!bv) merged = clone(lv || rv);
      else if (
        (lv && (!equal(lv, bv) || !equal(lf, bf))) ||
        (rv && (!equal(rv, bv) || !equal(rf, bf)))
      ) {
        mark("trip deletion versus edit");
        merged = rv ? clone(rv) : null;
      } else merged = null;
    } else if (!bv && !equal(lv, rv)) {
      mark("duplicate trip ID");
      merged = clone(rv);
    } else {
      const withoutLists = (t) => {
        const { items, packing, expenses, budgets, links, ...rest } = t || {};
        return rest;
      };
      merged = mergeFields(
        withoutLists(bv),
        withoutLists(lv),
        withoutLists(rv),
        mark,
      );
      for (const key of ["items", "packing", "expenses", "budgets", "links"])
        merged[key] = mergeList(
          bv?.[key] || [],
          lv[key],
          rv[key],
          mark,
          deleted,
        );
    }
    let mergedFiles = mergeList(bf, lf, rf, mark, deleted, true);
    if (merged) {
      try {
        checkManifests({ version: 1, trips: [merged] }, mergedFiles);
      } catch {
        mark("combined trip or file references need a choice");
      }
    } else mergedFiles = [];
    if (reasons.size) {
      const choice = choices[id];
      if (choice !== "cloud" && choice !== "copy")
        conflicts.push({
          tripId: id,
          name: lv?.name || rv?.name || bv?.name || "Trip",
          reasons: [...reasons],
          canCopy: Boolean(lv),
        });
      if (rv) {
        result.planner.trips.push(clone(rv));
        result.files.push(...clone(rf));
      }
      if (choice === "copy" && lv) {
        const copy = remapImport(result.planner, {
          planner: { version: 1, trips: [lv] },
          attachments: lf,
        });
        result.planner = copy.planner;
        result.files.push(
          ...copy.attachments.map((f) => ({ ...f, objectId: uid() })),
        );
      }
    } else if (merged) {
      result.planner.trips.push(merged);
      result.files.push(...mergedFiles);
    }
  }
  // A globally duplicated child ID after parallel additions is also a conflict.
  if (!conflicts.length) checkManifests(result.planner, result.files);
  return { ...result, conflicts };
}
function signature(trip, files) {
  const ids = new Map([[trip.id, "trip"]]);
  const normalized = clone(trip);
  normalized.id = "trip";
  for (const key of ["items", "packing", "expenses", "budgets", "links"])
    normalized[key].forEach((e, i) => {
      ids.set(e.id, key + ":" + i);
      e.id = key + ":" + i;
    });
  for (const e of normalized.expenses)
    if (e.planId) e.planId = ids.get(e.planId);
  return stable({
    trip: normalized,
    files: files
      .map((f) => ({
        plan: ids.get(f.planId),
        name: f.name,
        type: f.type,
        size: f.size,
        sha256: f.sha256,
      }))
      .sort((a, b) => stable(a).localeCompare(stable(b))),
  });
}
// Dedup only exact semantic trip+file copies, ignoring IDs changed by local
// backup import. Near matches remain separate to avoid losing edited bookings.
export function mergeFirstJoin(local, remote) {
  const result = { planner: clone(remote.planner), files: clone(remote.files) },
    signatures = new Set(
      remote.planner.trips.map((t) =>
        signature(
          t,
          remote.files.filter((f) => f.tripId === t.id),
        ),
      ),
    );
  let duplicates = 0;
  for (const t of local.planner.trips) {
    const attached = local.files.filter((f) => f.tripId === t.id),
      key = signature(t, attached);
    if (signatures.has(key)) {
      duplicates++;
      continue;
    }
    const copy = remapImport(result.planner, {
      planner: { version: 1, trips: [t] },
      attachments: attached,
    });
    result.planner = copy.planner;
    result.files.push(
      ...copy.attachments.map((f) => ({ ...f, objectId: uid() })),
    );
    signatures.add(key);
  }
  checkManifests(result.planner, result.files);
  return { ...result, duplicates };
}
