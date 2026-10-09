import test from "node:test";
import assert from "node:assert/strict";
import {
  blank,
  demoTrip,
  validate,
  validDate,
  dates,
  wallInstant,
  calendar,
  parseBackup,
  mergeBackup,
  safeURL,
  filteredItems,
  issues,
  totals,
  addDays,
} from "../model.js";
const planner = () => ({ version: 1, trips: [demoTrip()] });
test("date-only navigation handles leap days and DST without local-host timezone", () => {
  assert.deepEqual(dates("2028-02-28", "2028-03-01"), [
    "2028-02-28",
    "2028-02-29",
    "2028-03-01",
  ]);
  assert.equal(addDays("2027-03-14", 1), "2027-03-15");
  for (const d of ["2027-02-29", "2027-99-99", "x", "2027-02-31"])
    assert.equal(validDate(d), false);
});
test("wall times map to correct DST instants; nonexistent times fail and repeated times are explicit", () => {
  assert.equal(
    new Date(
      wallInstant("2027-03-13", "10:00", "America/New_York"),
    ).toISOString(),
    "2027-03-13T15:00:00.000Z",
  );
  assert.equal(
    new Date(
      wallInstant("2027-03-14", "10:00", "America/New_York"),
    ).toISOString(),
    "2027-03-14T14:00:00.000Z",
  );
  assert.throws(
    () => wallInstant("2027-03-14", "02:30", "America/New_York"),
    /does not exist/,
  );
  assert.equal(
    wallInstant("2027-11-07", "01:30", "America/New_York", "later") -
      wallInstant("2027-11-07", "01:30", "America/New_York", "earlier"),
    3600000,
  );
  assert.equal(
    wallInstant("2027-04-04", "01:45", "Australia/Lord_Howe", "later") -
      wallInstant("2027-04-04", "01:45", "Australia/Lord_Howe", "earlier"),
    1800000,
  );
  assert.throws(
    () => wallInstant("2011-12-30", "12:00", "Pacific/Apia"),
    /does not exist/,
  );
  assert.equal(
    new Date(
      wallInstant("2027-01-01", "00:00", "Asia/Kathmandu"),
    ).toISOString(),
    "2026-12-31T18:15:00.000Z",
  );
});
test("safe versioned backup roundtrip and append import preserve original records with fresh IDs", () => {
  const d = planner(),
    parsed = parseBackup(JSON.stringify(d));
  assert.deepEqual(parsed, d);
  const merged = mergeBackup(d, parsed);
  assert.equal(merged.trips.length, 2);
  assert.deepEqual(merged.trips[0], d.trips[0]);
  assert.notEqual(merged.trips[0].id, merged.trips[1].id);
  assert.notEqual(merged.trips[0].items[0].id, merged.trips[1].items[0].id);
  validate(merged);
});
test("strict imports reject unsupported versions, unknown fields, duplicate IDs, invalid shapes and unsafe links", () => {
  assert.throws(() => parseBackup("{"), /valid JSON/);
  assert.throws(() => parseBackup("x".repeat(2 * 1024 * 1024 + 1)), /2 MB/);
  assert.throws(() => parseBackup('{"version":9,"trips":[]}'), /version/);
  assert.throws(
    () => parseBackup('{"version":1,"trips":[],"__proto__":{}}'),
    /unsupported/,
  );
  const d = planner();
  d.trips[0].items[0].id = d.trips[0].id;
  assert.throws(() => validate(d), /duplicate/);
  for (const u of [
    "javascript:alert(1)",
    "data:text/html,x",
    "https://user:secret@example.com",
    "file:///tmp/x",
    "//example.com",
  ])
    assert.equal(safeURL(u), "");
  assert.equal(
    safeURL("https://example.com/?q=%3Cscript%3E"),
    "https://example.com/?q=%3Cscript%3E",
  );
  const x = planner();
  x.trips[0].items[0].ticketURL = "javascript:alert(1)";
  assert.throws(() => validate(x), /http/);
});
test("date range changes cannot silently drop activities or expenses", () => {
  const d = planner();
  d.trips[0].start = "2027-05-15";
  assert.throws(() => validate(d), /inside the trip/);
  const e = planner();
  e.trips[0].end = "2029-05-16";
  assert.throws(() => validate(e), /366/);
  const n = planner();
  n.trips[0].items[0].startTime = "";
  assert.throws(() => validate(n), /both/);
});
test("search, status and kind combine while date choices stay independent", () => {
  const t = demoTrip();
  assert.equal(
    filteredItems(t, t.start, "harbour", "suggested", "activity").length,
    1,
  );
  assert.equal(
    filteredItems(t, t.start, "harbour", "booked", "activity").length,
    0,
  );
  assert.equal(
    filteredItems(t, t.end, "guesthouse", "all", "accommodation").length,
    1,
  );
  assert.equal(filteredItems(t, addDays(t.start, 1), "harbour").length, 0);
});
test("logistics reminders cover checkout nights and detect actual overlaps across timezones", () => {
  const t = demoTrip();
  assert.equal(issues(t).length, 1);
  assert.match(issues(t)[0].text, /last day/);
  t.items = t.items.filter((i) => i.kind !== "accommodation");
  assert.equal(
    issues(t).filter((w) => w.text.startsWith("No accommodation")).length,
    2,
  );
  t.items.push({
    ...t.items[0],
    id: crypto.randomUUID(),
    title: "Overlapping flight",
    startTime: "10:00",
    endTime: "12:00",
    timezone: "Europe/London",
    endTimezone: "Europe/London",
  });
  assert.ok(issues(t).some((w) => w.text.includes("Time overlap")));
  t.items[0].status = "booked";
  assert.ok(issues(t).some((w) => w.text.includes("No booking")));
});
test("currency totals stay separate and correctly round decimal money", () => {
  const t = demoTrip();
  t.expenses.push(
    {
      id: crypto.randomUUID(),
      title: "Tea",
      amount: 0.1,
      currency: "USD",
      date: t.start,
      category: "Food",
      paymentStatus: "paid",
      planId: "",
    },
    {
      id: crypto.randomUUID(),
      title: "Coffee",
      amount: 0.2,
      currency: "USD",
      date: t.start,
      category: "Food",
      paymentStatus: "paid",
      planId: "",
    },
  );
  validate({ version: 1, trips: [t] });
  assert.deepEqual(totals(t), {
    GBP: { paid: 0, planned: 45, total: 45, budget: 400 },
    USD: { paid: 0.3, planned: 0, total: 0.3, budget: 0 },
  });
  t.expenses[0].currency = "XYZ";
  assert.throws(() => validate({ version: 1, trips: [t] }), /currency/);
  t.expenses[0].currency = "JPY";
  t.expenses[0].amount = 1.5;
  assert.throws(() => validate({ version: 1, trips: [t] }), /decimal/);
});
test("calendar exports UTC instants, exclusive all-day ends, booking status, escaped text and folded UTF-8", () => {
  const t = demoTrip();
  t.items[0].title = "Title, with; punctuation\\ and\nBEGIN:VEVENT";
  t.items[0].status = "booked";
  t.items[0].notes = "🌍".repeat(100);
  const ics = calendar(t, Date.parse("2027-01-01T00:00:00Z"));
  assert.match(ics, /DTSTART:20270514T083000Z/);
  assert.match(ics, /DTEND;VALUE=DATE:20270516/);
  assert.match(ics, /STATUS:CONFIRMED/);
  assert.match(ics, /Title\\, with\\; punctuation\\\\ and\\nBEGIN:VEVENT/);
  assert.equal(ics.split("\r\n").filter((l) => l === "BEGIN:VEVENT").length, 5);
  for (const l of ics.split("\r\n"))
    assert.ok(new TextEncoder().encode(l).length <= 75);
});
test("empty planner is usable; text with markup remains inert data", () => {
  assert.deepEqual(parseBackup(JSON.stringify(blank())), blank());
  const d = planner();
  d.trips[0].name = "<img src=x onerror=alert(1)>";
  validate(d);
  assert.equal(parseBackup(JSON.stringify(d)).trips[0].name, d.trips[0].name);
});
test("dateline travel accepts valid instant order despite arrival local date preceding departure", () => {
  const d = planner(),
    i = d.trips[0].items[0];
  Object.assign(i, {
    startDate: "2027-05-15",
    endDate: "2027-05-14",
    startTime: "00:30",
    endTime: "19:30",
    timezone: "Asia/Tokyo",
    endTimezone: "America/Los_Angeles",
  });
  validate(d);
  assert.ok(filteredItems(d.trips[0], "2027-05-14").some((x) => x.id === i.id));
  assert.match(
    calendar(d.trips[0]),
    /DTSTART:20270514T153000Z\r\nDTEND:20270515T023000Z/,
  );
});
test("standalone carriage returns cannot inject calendar properties", () => {
  const t = demoTrip();
  t.items[0].title = "Safe\rBEGIN:VEVENT";
  const ics = calendar(t);
  assert.match(ics, /SUMMARY:Safe\\nBEGIN:VEVENT/);
  assert.equal(ics.split("\r\n").filter((l) => l === "BEGIN:VEVENT").length, 5);
});
test("serialized storage cap guarantees compact exported backups can be restored", () => {
  const d = planner(),
    base = d.trips[0].items[0];
  d.trips[0].items = Array.from({ length: 380 }, () => ({
    ...base,
    id: crypto.randomUUID(),
    notes: "x".repeat(5000),
  }));
  d.trips[0].expenses[0].planId = d.trips[0].items[0].id;
  const exported = JSON.stringify(d);
  assert.ok(new TextEncoder().encode(exported).length < 2 * 1024 * 1024);
  assert.equal(parseBackup(exported).trips[0].items.length, 380);
  d.trips[0].items.push(
    ...Array.from({ length: 120 }, () => ({
      ...base,
      id: crypto.randomUUID(),
      notes: "x".repeat(5000),
    })),
  );
  assert.throws(() => validate(d), /2 MB/);
});
test("timed day plans sort by actual chronology across timezones, not local clock strings", () => {
  const t = demoTrip(),
    first = t.items[0],
    second = t.items[2];
  first.startTime = "10:00";
  first.endTime = "11:00";
  first.timezone = first.endTimezone = "Asia/Tokyo";
  second.startTime = "08:00";
  second.endTime = "09:00";
  second.timezone = second.endTimezone = "Europe/London";
  assert.equal(
    filteredItems(t, t.start).filter((i) => i.startTime)[0].id,
    first.id,
  );
});
test("currency precision validation does not silently round tiny entered amounts", () => {
  const d = planner();
  d.trips[0].expenses[0].amount = 0.000001;
  assert.throws(() => validate(d), /decimal/);
});
test("paid and planned costs, zero values and budgets remain isolated for each trip and currency", () => {
  const a = demoTrip(),
    b = demoTrip();
  a.expenses = [
    {
      id: crypto.randomUUID(),
      title: "Zero planned cost",
      amount: 0,
      currency: "USD",
      date: a.start,
      category: "Food",
      paymentStatus: "planned",
      planId: "",
    },
    {
      id: crypto.randomUUID(),
      title: "Paid meal",
      amount: 12.34,
      currency: "USD",
      date: a.start,
      category: "Food",
      paymentStatus: "paid",
      planId: a.items[0].id,
    },
  ];
  validate({ version: 1, trips: [a, b] });
  assert.deepEqual(totals(a).USD, {
    paid: 12.34,
    planned: 0,
    total: 12.34,
    budget: 0,
  });
  assert.equal(totals(b).USD, undefined);
  a.expenses[0].amount = 3.21;
  assert.equal(totals(a).USD.total, 15.55);
  a.expenses = a.expenses.filter((e) => e.paymentStatus !== "paid");
  assert.deepEqual(totals(a).USD, {
    paid: 0,
    planned: 3.21,
    total: 3.21,
    budget: 0,
  });
  assert.equal(totals(b).GBP.total, 45);
});
test("linked cost remains a single expense and import remaps its plan to the imported copy", () => {
  const d = planner(),
    t = d.trips[0];
  assert.equal(totals(t).GBP.total, 45);
  const copied = mergeBackup(blank(), d).trips[0];
  assert.equal(copied.expenses[0].planId, copied.items[0].id);
  assert.notEqual(copied.expenses[0].planId, t.items[0].id);
  assert.equal(totals(copied).GBP.total, 45);
  t.expenses[0].planId = "missing-plan";
  assert.throws(() => validate(d), /reference a plan/);
});
