import test from "node:test";
import assert from "node:assert/strict";
import { blank, demoTrip } from "../model.js";
import {
  filename,
  checkFile,
  makeRecords,
  portableBackup,
  readPortableBackup,
  remapImport,
  ownedFiles,
  MAX_FILE,
} from "../attachments.js";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lxoAAAAASUVORK5CYII=",
  "base64",
);
test("safe filenames retain a correct extension and cannot introduce paths or executable names", () => {
  assert.equal(filename("../evil.html", "image/png"), "_evil.html.png");
  assert.ok(filename("x".repeat(200), "application/pdf").length <= 120);
  assert.match(filename("untrusted.svg", "image/png"), /\.png$/);
  assert.throws(() => filename("x", "image/svg+xml"), /Only PDF/);
});
test("file type, magic and size checks reject executable or disguised content", async () => {
  await checkFile(new Blob([png], { type: "image/png" }));
  await assert.rejects(
    checkFile(new Blob(["<script>"], { type: "image/png" })),
    /match/,
  );
  await assert.rejects(
    checkFile(new Blob(["<svg/>"], { type: "image/svg+xml" })),
    /not accepted/,
  );
  await assert.rejects(
    checkFile(
      new Blob([new Uint8Array(MAX_FILE + 1)], { type: "application/pdf" }),
    ),
    /5 MB/,
  );
});
test("portable JSON backs up exact binary bytes and import remaps ownership without mixing trips", async () => {
  const t = demoTrip(),
    planner = { version: 1, trips: [t] },
    rows = await makeRecords(
      [new File([png], "fictional.png", { type: "image/png" })],
      t.id,
      t.items[0].id,
    ),
    text = await portableBackup(planner, rows),
    incoming = await readPortableBackup(text);
  assert.deepEqual(
    new Uint8Array(await incoming.attachments[0].blob.arrayBuffer()),
    new Uint8Array(png),
  );
  const copied = remapImport(planner, incoming);
  assert.equal(copied.planner.trips.length, 2);
  assert.equal(copied.attachments[0].tripId, copied.planner.trips[1].id);
  assert.equal(
    copied.attachments[0].planId,
    copied.planner.trips[1].items[0].id,
  );
  assert.notEqual(copied.attachments[0].id, rows[0].id);
  assert.equal(
    ownedFiles(
      { version: 1, trips: [copied.planner.trips[0]] },
      copied.attachments,
    ).length,
    0,
  );
});
test("legacy text backups still import, and full backups reject malformed or orphaned files", async () => {
  assert.deepEqual(await readPortableBackup(JSON.stringify(blank())), {
    planner: blank(),
    attachments: [],
  });
  const t = demoTrip(),
    rows = await makeRecords(
      [new File([png], "fictional.png", { type: "image/png" })],
      t.id,
      t.items[0].id,
    ),
    full = JSON.parse(await portableBackup({ version: 1, trips: [t] }, rows));
  full.attachments[0].planId = "missing";
  await assert.rejects(readPortableBackup(JSON.stringify(full)), /owning plan/);
  full.attachments[0].planId = t.items[0].id;
  full.attachments[0].size++;
  await assert.rejects(readPortableBackup(JSON.stringify(full)), /byte count/);
});
