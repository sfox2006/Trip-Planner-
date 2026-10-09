// All user content remains data. This module never evaluates HTML or makes network requests.
export const VERSION = 1;
export const STORAGE_KEY = "personal-trip-planner.v1";
export const uid = () => crypto.randomUUID();
export const blank = () => ({ version: VERSION, trips: [] });
export function validDate(s) {
  return (
    typeof s === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    s >= "1900-01-01" &&
    s <= "2100-12-31" &&
    Number.isFinite(Date.parse(`${s}T12:00:00Z`)) &&
    new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s
  );
}
export function addDays(s, n) {
  const d = new Date(`${s}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function dates(start, end) {
  const out = [];
  for (let d = start; d <= end && out.length < 367; d = addDays(d, 1))
    out.push(d);
  return out;
}
export function dateLabel(s, options = { month: "short", day: "numeric" }) {
  return new Intl.DateTimeFormat("en-US", {
    ...options,
    timeZone: "UTC",
  }).format(new Date(`${s}T12:00:00Z`));
}
export function validZone(zone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format();
    return typeof zone === "string" && zone.length > 0;
  } catch {
    return false;
  }
}
const formatters = new Map();
function wallParts(instant, zone) {
  if (!formatters.has(zone))
    formatters.set(
      zone,
      new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
    );
  const p = Object.fromEntries(
    formatters
      .get(zone)
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export function wallInstant(date, time, zone, choice = "earlier") {
  if (
    !validDate(date) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ||
    !validZone(zone)
  )
    throw Error("Use a valid date, time and IANA timezone.");
  const wall = `${date}T${time}`,
    naive = Date.parse(`${wall}:00Z`),
    offsets = new Set();
  // Probe both sides of transitions (including half-hour DST and skipped civil days).
  for (let h = -48; h <= 48; h += 6) {
    const t = naive + h * 3600000;
    offsets.add(Date.parse(`${wallParts(t, zone)}:00Z`) - t);
  }
  const matches = [...offsets]
    .map((offset) => naive - offset)
    .filter((t) => wallParts(t, zone) === wall)
    .sort((a, b) => a - b);
  if (!matches.length)
    throw Error(
      `${date} ${time} does not exist in ${zone} because the clock changes. Choose another time.`,
    );
  return matches[choice === "later" ? matches.length - 1 : 0];
}
function exact(o, keys) {
  if (
    !o ||
    typeof o !== "object" ||
    Array.isArray(o) ||
    Object.keys(o).some((k) => !keys.includes(k))
  )
    throw Error("Backup has unsupported fields or objects.");
}
function str(s, max = 2000, required = false) {
  if (
    typeof s !== "string" ||
    s.length > max ||
    (required && !s.trim()) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)
  )
    throw Error(
      "A text field is missing, too long, or contains control characters.",
    );
}
function list(a, max = 2000) {
  if (!Array.isArray(a) || a.length > max)
    throw Error("Backup contains too many records or an invalid list.");
}
function id(s, seen) {
  str(s, 100, true);
  if (!/^[A-Za-z0-9_-]+$/.test(s))
    throw Error(
      "Record IDs must contain only letters, numbers, underscores or hyphens.",
    );
  if (seen.has(s)) throw Error("Backup contains duplicate IDs.");
  seen.add(s);
}
export function safeURL(s) {
  if (!s) return "";
  try {
    const u = new URL(s);
    return ["https:", "http:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : "";
  } catch {
    return "";
  }
}
function url(s) {
  str(s, 2000);
  if (s && !safeURL(s))
    throw Error(
      "Links must be full http:// or https:// URLs without embedded credentials.",
    );
}
export function validCurrency(c) {
  return (
    typeof c === "string" &&
    /^[A-Z]{3}$/.test(c) &&
    (!Intl.supportedValuesOf || Intl.supportedValuesOf("currency").includes(c))
  );
}
export function money(amount, currency) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    currencyDisplay: "code",
  }).format(amount);
}
export function validate(data) {
  exact(data, ["version", "trips"]);
  if (data.version !== VERSION)
    throw Error("Unsupported backup version. Expected version 1.");
  list(data.trips, 100);
  const seen = new Set();
  for (const t of data.trips) {
    exact(t, [
      "id",
      "name",
      "destination",
      "start",
      "end",
      "timezone",
      "notes",
      "items",
      "packing",
      "expenses",
      "budgets",
      "links",
    ]);
    id(t.id, seen);
    str(t.name, 100, true);
    str(t.destination, 150, true);
    str(t.notes, 5000);
    if (
      !validDate(t.start) ||
      !validDate(t.end) ||
      t.end < t.start ||
      dates(t.start, t.end).length > 366
    )
      throw Error(
        "Trips need an ordered date range of up to 366 days, between 1900 and 2100.",
      );
    if (!validZone(t.timezone))
      throw Error(
        "Choose a valid IANA timezone, for example America/New_York.",
      );
    for (const key of ["items", "packing", "expenses", "budgets", "links"])
      list(t[key], key === "items" ? 500 : 2000);
    for (const i of t.items) {
      exact(i, [
        "id",
        "kind",
        "title",
        "startDate",
        "endDate",
        "startTime",
        "endTime",
        "timezone",
        "endTimezone",
        "occurrence",
        "endOccurrence",
        "location",
        "notes",
        "status",
        "bookingURL",
        "ticketURL",
      ]);
      id(i.id, seen);
      if (
        !["activity", "accommodation", "transport"].includes(i.kind) ||
        !["booked", "suggested"].includes(i.status)
      )
        throw Error("Invalid item type or booking status.");
      str(i.title, 150, true);
      str(i.location, 500);
      str(i.notes, 5000);
      url(i.bookingURL);
      url(i.ticketURL);
      if (
        !validDate(i.startDate) ||
        !validDate(i.endDate) ||
        i.startDate < t.start ||
        i.startDate > t.end ||
        i.endDate < t.start ||
        i.endDate > t.end ||
        ((!i.startTime || i.kind === "accommodation") &&
          i.endDate < i.startDate)
      )
        throw Error(
          "Each item must fit inside the trip dates. Extend the trip first.",
        );
      if (
        !validZone(i.timezone) ||
        !validZone(i.endTimezone) ||
        !["earlier", "later"].includes(i.occurrence) ||
        !["earlier", "later"].includes(i.endOccurrence)
      )
        throw Error("Invalid timezone or clock occurrence.");
      str(i.startTime, 5);
      str(i.endTime, 5);
      if (Boolean(i.startTime) !== Boolean(i.endTime))
        throw Error(
          "Enter both start and end times, or leave both blank for an unscheduled / all-day item.",
        );
      if (
        i.startTime &&
        wallInstant(i.endDate, i.endTime, i.endTimezone, i.endOccurrence) <=
          wallInstant(i.startDate, i.startTime, i.timezone, i.occurrence)
      )
        throw Error(
          "End time must be after start time, including timezone changes.",
        );
    }
    for (const p of t.packing) {
      exact(p, ["id", "text", "checked"]);
      id(p.id, seen);
      str(p.text, 200, true);
      if (typeof p.checked !== "boolean") throw Error("Invalid packing check.");
    }
    for (const [key, fields] of [
      [
        "expenses",
        [
          "id",
          "title",
          "amount",
          "currency",
          "date",
          "category",
          "paymentStatus",
          "planId",
        ],
      ],
      ["budgets", ["id", "title", "amount", "currency"]],
    ])
      for (const e of t[key]) {
        exact(e, fields);
        id(e.id, seen);
        str(e.title, 150, true);
        if (
          typeof e.amount !== "number" ||
          !Number.isFinite(e.amount) ||
          e.amount < 0 ||
          e.amount > 1e12 ||
          !validCurrency(e.currency)
        )
          throw Error(
            "Use a nonnegative amount and a valid three-letter currency code.",
          );
        const digits = new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: e.currency,
        }).resolvedOptions().maximumFractionDigits;
        if (e.amount !== Number(e.amount.toFixed(digits)))
          throw Error(`${e.currency} supports ${digits} decimal places.`);
        if (key === "expenses") {
          if (!validDate(e.date) || e.date < t.start || e.date > t.end)
            throw Error("Expense date must fit within the trip.");
          str(e.category, 100, true);
          if (!["paid", "planned"].includes(e.paymentStatus))
            throw Error("Choose whether the cost is paid or planned.");
          str(e.planId, 100);
          if (e.planId && !t.items.some((i) => i.id === e.planId))
            throw Error("Linked cost must reference a plan in this trip.");
        }
      }
    for (const l of t.links) {
      exact(l, ["id", "title", "url"]);
      id(l.id, seen);
      str(l.title, 150, true);
      url(l.url);
      if (!l.url) throw Error("Enter a link URL.");
    }
  }
  if (new TextEncoder().encode(JSON.stringify(data)).length > 2 * 1024 * 1024)
    throw Error(
      "Planner data must stay smaller than 2 MB so backups can be restored.",
    );
  return data;
}
export function parseBackup(text) {
  if (
    typeof text !== "string" ||
    new TextEncoder().encode(text).length > 2 * 1024 * 1024
  )
    throw Error("Backup must be smaller than 2 MB.");
  try {
    return validate(JSON.parse(text));
  } catch (e) {
    if (e instanceof SyntaxError) throw Error("This file is not valid JSON.");
    throw e;
  }
}
export function mergeBackup(current, incoming) {
  const copied = structuredClone(incoming);
  for (const t of copied.trips) {
    t.id = uid();
    const itemIDs = new Map();
    for (const i of t.items) {
      const old = i.id;
      i.id = uid();
      itemIDs.set(old, i.id);
    }
    for (const k of ["packing", "expenses", "budgets", "links"])
      t[k].forEach((i) => (i.id = uid()));
    for (const e of t.expenses) if (e.planId) e.planId = itemIDs.get(e.planId);
  }
  return validate({
    version: VERSION,
    trips: [...current.trips, ...copied.trips],
  });
}
export function activeOn(i, date) {
  return (
    (i.startDate < i.endDate ? i.startDate : i.endDate) <= date &&
    (i.startDate > i.endDate ? i.startDate : i.endDate) >= date
  );
}
export function filteredItems(
  t,
  date,
  query = "",
  status = "all",
  kind = "all",
) {
  const q = query.trim().toLowerCase();
  return t.items
    .filter(
      (i) =>
        activeOn(i, date) &&
        (status === "all" || status === i.status) &&
        (kind === "all" || kind === i.kind) &&
        `${i.title} ${i.location} ${i.notes}`.toLowerCase().includes(q),
    )
    .map((i) => ({
      item: i,
      instant: i.startTime
        ? wallInstant(i.startDate, i.startTime, i.timezone, i.occurrence)
        : Infinity,
    }))
    .sort(
      (a, b) =>
        a.instant - b.instant || a.item.title.localeCompare(b.item.title),
    )
    .map((x) => x.item);
}
export function issues(t) {
  const out = [];
  if (t.end > t.start)
    for (const day of dates(t.start, addDays(t.end, -1)))
      if (
        !t.items.some(
          (i) =>
            i.kind === "accommodation" && i.startDate <= day && i.endDate > day,
        )
      )
        out.push({
          text: `No accommodation recorded for ${dateLabel(day)}.`,
          date: day,
        });
  for (const [d, label] of t.start === t.end
    ? [[t.start, "the trip day"]]
    : [
        [t.start, "the first day"],
        [t.end, "the last day"],
      ])
    if (!t.items.some((i) => i.kind === "transport" && activeOn(i, d)))
      out.push({
        text: `No transport recorded on ${label}. Check arrival and departure details.`,
        date: d,
      });
  for (const i of t.items) {
    if (!i.location.trim())
      out.push({ text: `Location missing: ${i.title}.`, date: i.startDate });
    if (i.status === "booked" && !i.bookingURL && !i.ticketURL)
      out.push({
        text: `No booking or ticket link: ${i.title}.`,
        date: i.startDate,
      });
  }
  const timed = t.items
    .filter((i) => i.kind !== "accommodation" && i.startTime)
    .map((i) => ({
      item: i,
      start: wallInstant(i.startDate, i.startTime, i.timezone, i.occurrence),
      end: wallInstant(i.endDate, i.endTime, i.endTimezone, i.endOccurrence),
    }))
    .sort((a, b) => a.start - b.start);
  let overlaps = 0;
  for (let a = 0; a < timed.length; a++)
    for (
      let b = a + 1;
      b < timed.length && timed[b].start < timed[a].end;
      b++
    ) {
      overlaps++;
      if (overlaps <= 100)
        out.push({
          text: `Time overlap: ${timed[a].item.title} and ${timed[b].item.title}.`,
          date: timed[a].item.startDate,
        });
    }
  if (overlaps > 100)
    out.push({
      text: `${overlaps - 100} additional overlapping pairs. Review the timed plans.`,
      date: t.start,
    });
  return out;
}
export function totals(t) {
  const result = {};
  const ensure = (c) =>
    (result[c] ??= { paid: 0, planned: 0, total: 0, budget: 0 });
  for (const e of t.expenses) {
    ensure(e.currency);
    result[e.currency][e.paymentStatus] += e.amount;
    result[e.currency].total += e.amount;
  }
  for (const b of t.budgets) {
    ensure(b.currency);
    result[b.currency].budget += b.amount;
  }
  for (const [c, value] of Object.entries(result)) {
    const digits = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: c,
    }).resolvedOptions().maximumFractionDigits;
    for (const f of ["paid", "planned", "total", "budget"])
      value[f] = Number(value[f].toFixed(digits));
  }
  return result;
}

const icsEscape = (s) =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
const utc = (t) =>
  new Date(t)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
function fold(line) {
  let out = "",
    part = "",
    bytes = 0;
  for (const char of line) {
    const n = new TextEncoder().encode(char).length;
    if (bytes + n > 75) {
      out += part + "\r\n";
      part = " ";
      bytes = 1;
    }
    part += char;
    bytes += n;
  }
  return out + part;
}
export function calendar(t, now = Date.now()) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Personal Trip Planner//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  for (const i of t.items) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${icsEscape(i.id)}@personal-trip-planner.local`,
      `DTSTAMP:${utc(now)}`,
    );
    if (i.startTime)
      lines.push(
        `DTSTART:${utc(wallInstant(i.startDate, i.startTime, i.timezone, i.occurrence))}`,
        `DTEND:${utc(wallInstant(i.endDate, i.endTime, i.endTimezone, i.endOccurrence))}`,
      );
    else
      lines.push(
        `DTSTART;VALUE=DATE:${i.startDate.replaceAll("-", "")}`,
        `DTEND;VALUE=DATE:${(i.kind === "accommodation" && i.endDate > i.startDate ? i.endDate : addDays(i.endDate, 1)).replaceAll("-", "")}`,
      );
    lines.push(
      `SUMMARY:${icsEscape(i.title)}`,
      `LOCATION:${icsEscape(i.location)}`,
      `DESCRIPTION:${icsEscape(`${i.status.toUpperCase()} · ${i.kind}\n${i.notes}\nStart timezone: ${i.timezone}\nEnd timezone: ${i.endTimezone}\n${i.bookingURL}\n${i.ticketURL}`)}`,
      i.status === "booked" ? "STATUS:CONFIRMED" : "STATUS:TENTATIVE",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
export function demoTrip() {
  const t = {
    id: uid(),
    name: "A little coastal escape",
    destination: "Port Azure · fictional demo",
    start: "2027-05-14",
    end: "2027-05-16",
    timezone: "Europe/London",
    notes: "Fictional example. Make this planner your own by creating a trip.",
    items: [],
    packing: [],
    expenses: [],
    budgets: [],
    links: [],
  };
  const item = (
    kind,
    title,
    startDate,
    endDate,
    startTime,
    endTime,
    location,
    status,
    notes,
  ) => ({
    id: uid(),
    kind,
    title,
    startDate,
    endDate,
    startTime,
    endTime,
    timezone: t.timezone,
    endTimezone: t.timezone,
    occurrence: "earlier",
    endOccurrence: "earlier",
    location,
    status,
    notes,
    bookingURL: "",
    ticketURL: "",
  });
  t.items = [
    item(
      "transport",
      "Train to the coast",
      t.start,
      t.start,
      "09:30",
      "11:00",
      "Central station → Port Azure",
      "suggested",
      "Allow time to find the platform.",
    ),
    item(
      "accommodation",
      "The Sea Glass Guesthouse",
      t.start,
      t.end,
      "",
      "",
      "Fictional waterfront guesthouse",
      "suggested",
      "Two nights. Add check-in details after booking.",
    ),
    item(
      "activity",
      "Lunch by the harbour",
      t.start,
      t.start,
      "12:00",
      "13:00",
      "Old harbour",
      "suggested",
      "A slow lunch and a first look around.",
    ),
    item(
      "activity",
      "Walk the lighthouse trail",
      t.start,
      t.start,
      "15:00",
      "17:00",
      "West coast path",
      "suggested",
      "Bring a light layer and comfortable shoes.",
    ),
    item(
      "activity",
      "Browse the Sunday market",
      t.end,
      t.end,
      "10:00",
      "11:30",
      "Market square",
      "suggested",
      "Pick up something for the journey home.",
    ),
  ];
  t.packing = [
    { id: uid(), text: "Comfortable walking shoes", checked: true },
    { id: uid(), text: "Light rain jacket", checked: false },
    { id: uid(), text: "Phone charger", checked: false },
  ];
  t.budgets = [
    { id: uid(), title: "Weekend budget", amount: 400, currency: "GBP" },
  ];
  t.expenses = [
    {
      id: uid(),
      title: "Train estimate",
      amount: 45,
      currency: "GBP",
      date: t.start,
      category: "Transport",
      paymentStatus: "planned",
      planId: t.items[0].id,
    },
  ];
  return t;
}
