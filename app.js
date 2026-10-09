import {
  files,
  fileFingerprint,
  makeRecords,
  filename,
  ownedFiles,
  portableBackup,
  readPortableBackup,
  remapImport,
  MAX_BACKUP,
} from "./attachments.js";
import {
  STORAGE_KEY,
  blank,
  uid,
  validate,
  parseBackup,
  mergeBackup,
  dates,
  addDays,
  dateLabel,
  filteredItems,
  issues,
  totals,
  money,
  safeURL,
  calendar,
  demoTrip,
} from "./model.js";
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const append = (parent, ...children) => {
  parent.append(...children);
  return parent;
};
const button = (text, action, cls = "button") => {
  const b = el("button", cls, text);
  b.type = "button";
  b.addEventListener("click", action);
  return b;
};
let syncWriteBusy = false;
let fileBusy = 0,
  previewSequence = 0;
let attachmentRows = [],
  filesReady = false;
const fileURLs = new Map();
let previewTask = null,
  previewRender = null;
const tripStates = new Map();
let tripQuery = "",
  tripDateFilter = "all";
const localToday = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};
const link = (text, url) => {
  const a = el("a", "", text);
  a.href = safeURL(url);
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.referrerPolicy = "no-referrer";
  return a;
};
let data = blank(),
  selected = "",
  day = "",
  section = "itinerary",
  query = "",
  status = "all",
  kind = "all",
  lastSaved = null,
  blockedStorage = false,
  pendingImport = null,
  importSequence = 0,
  editorConfig = null,
  confirmAction = null,
  dialogOpener = null,
  noticeTimer;
function storageWarning(text) {
  $("storage-warning").textContent = text;
  $("storage-warning").hidden = false;
}
try {
  lastSaved = localStorage.getItem(STORAGE_KEY);
  if (lastSaved) data = parseBackup(lastSaved);
  else if (localStorage.getItem("personal-trip-planner.sync-projection"))
    localStorage.setItem("personal-trip-planner.sync-reset", uid());
} catch (e) {
  blockedStorage = true;
  storageWarning(
    `Saved data could not be loaded: ${e.message} Existing storage is left untouched. Changes are only in this tab. Use Backup & privacy to recover or reset it.`,
  );
}
selected = data.trips[0]?.id || "";
day = data.trips[0]?.start || "";
function trip() {
  return data.trips.find((t) => t.id === selected);
}
function rememberTrip() {
  if (selected) tripStates.set(selected, { day, section, query, status, kind });
}
function restoreTrip(id) {
  selected = id;
  const t = trip(),
    state = tripStates.get(id) || {
      day: t?.start || "",
      section: "itinerary",
      query: "",
      status: "all",
      kind: "all",
    };
  ({ day, section, query, status, kind } = state);
  $("search").value = query;
  $("status-filter").value = status;
  $("kind-filter").value = kind;
}
function activateTrip(id) {
  rememberTrip();
  restoreTrip(id);
  render();
  window.scrollTo({ top: 0, behavior: "instant" });
  const choice = $("trip-" + id);
  if (choice) choice.focus({ preventScroll: true });
  else $("main").focus({ preventScroll: true });
}
function renderTripList() {
  const today = localToday(),
    visible = data.trips.filter(
      (t) =>
        `${t.name} ${t.destination}`
          .toLowerCase()
          .includes(tripQuery.trim().toLowerCase()) &&
        (tripDateFilter === "all" ||
          (tripDateFilter === "past" ? t.end < today : t.end >= today)),
    );
  $("trip-count").textContent =
    visible.length === data.trips.length
      ? String(data.trips.length)
      : `${visible.length}/${data.trips.length}`;
  $("trip-list").replaceChildren();
  for (const t of visible) {
    const b = button("", () => activateTrip(t.id), "trip-choice");
    b.id = "trip-" + t.id;
    b.setAttribute("aria-pressed", t.id === selected);
    append(
      b,
      el("strong", "", t.name),
      el(
        "span",
        "",
        `${dateLabel(t.start)} – ${dateLabel(t.end)} · ${t.destination}`,
      ),
    );
    $("trip-list").append(b);
  }
  if (!visible.length && data.trips.length) {
    const n = el("div", "trip-filter-empty");
    append(
      n,
      el("p", "muted", "No trips match these filters."),
      button(
        "Clear trip filters",
        () => {
          tripQuery = "";
          tripDateFilter = "all";
          $("trip-search").value = "";
          $("trip-date-filter").value = "all";
          renderTripList();
        },
        "text-button",
      ),
    );
    $("trip-list").append(n);
  }
}
$("trip-search").oninput = (e) => {
  tripQuery = e.target.value;
  renderTripList();
};
$("trip-date-filter").onchange = (e) => {
  tripDateFilter = e.target.value;
  renderTripList();
};
function notify(text) {
  clearTimeout(noticeTimer);
  $("notice").textContent = text;
  $("notice").hidden = false;
  noticeTimer = setTimeout(() => ($("notice").hidden = true), 4500);
}
function commit(next) {
  if (syncWriteBusy)
    throw Error("Wait for the current sync refresh before editing.");
  validate(next);
  if (!blockedStorage) {
    try {
      if (localStorage.getItem(STORAGE_KEY) !== lastSaved) {
        throw Error(
          "Plans changed in another tab. Reload this page before saving to avoid overwriting them.",
        );
      }
      const raw = JSON.stringify(next);
      localStorage.setItem(STORAGE_KEY, raw);
      lastSaved = raw;
      $("storage-warning").hidden = true;
    } catch (e) {
      if (e.message.startsWith("Plans changed")) throw e;
      blockedStorage = true;
      storageWarning(
        `Browser storage is unavailable or full. Changes are held only in this tab and may be lost on reload. Download a backup. (${e.message})`,
      );
    }
  }
  data = next;
  render();
  void cleanupAttachments();
  document.dispatchEvent(new Event("ptp-local-change"));
}
function updateTrip(update) {
  const next = structuredClone(data),
    t = next.trips.find((t) => t.id === selected);
  update(t);
  commit(next);
}
function openDialog(id) {
  dialogOpener = document.activeElement;
  $(id).showModal();
}
function closeDialog(id) {
  $(id).close();
  if (dialogOpener?.isConnected) dialogOpener.focus();
  else $("main").focus({ preventScroll: true });
}
for (const id of [
  "editor",
  "backup-dialog",
  "confirm-dialog",
  "attachment-preview",
]) {
  const dialog = $(id);
  dialog.addEventListener("close", () => {
    if (dialogOpener?.isConnected) dialogOpener.focus();
  });
  dialog.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const controls = [
      ...dialog.querySelectorAll(
        "button,a[href],input,select,textarea,[tabindex]",
      ),
    ].filter(
      (n) => !n.disabled && n.tabIndex >= 0 && n.getClientRects().length,
    );
    const first = controls[0],
      last = controls.at(-1);
    if (
      (e.shiftKey && document.activeElement === first) ||
      (!e.shiftKey && document.activeElement === last)
    ) {
      e.preventDefault();
      (e.shiftKey ? last : first)?.focus();
    }
  });
}
function confirm(title, description, action) {
  confirmAction = action;
  $("confirm-title").textContent = title;
  $("confirm-description").textContent = description;
  openDialog("confirm-dialog");
}
$("confirm-cancel").onclick = () => closeDialog("confirm-dialog");
$("confirm-delete").onclick = async () => {
  closeDialog("confirm-dialog");
  try {
    await confirmAction();
    notify("Deleted.");
  } catch (e) {
    notify(e.message);
  }
};
function empty(parent, title, text, action, label) {
  const n = el("div", "empty");
  append(
    n,
    el("div", "empty-symbol", "◇"),
    el("h3", "", title),
    el("p", "", text),
  );
  if (action) n.append(button(label, action, "button primary"));
  parent.append(n);
}
function setDay(date, focus = false) {
  const t = trip();
  if (!t || date < t.start || date > t.end) return;
  day = date;
  render();
  window.scrollTo({ top: 0, behavior: "instant" });
  if (focus) $("day-heading").focus({ preventScroll: true });
}
function render() {
  document
    .querySelector(".local-badge")
    .replaceChildren(
      el("span", "dot"),
      document.createTextNode(
        blockedStorage
          ? "Session only · save a backup"
          : "Stored on this device",
      ),
    );
  document.querySelector(".trip-bottom .muted").textContent = blockedStorage
    ? "Changes are held only in this tab. Download a backup."
    : "Changes are saved in this browser.";
  if (!trip()) restoreTrip(data.trips[0]?.id || "");
  const t = trip();
  $("welcome").hidden = !!t;
  $("trip-view").hidden = !t;
  renderTripList();
  if (!t) return;
  if (day < t.start || day > t.end) day = t.start;
  $("trip-heading").textContent = t.name;
  $("trip-meta").textContent =
    `${t.destination}  ·  ${dateLabel(t.start, { month: "short", day: "numeric", year: "numeric" })} – ${dateLabel(t.end, { month: "short", day: "numeric", year: "numeric" })}  ·  ${t.timezone}`;
  $("trip-notes").textContent = t.notes;
  $("trip-notes").hidden = !t.notes;
  const summary = $("trip-summary");
  summary.replaceChildren();
  for (const [n, label] of [
    [dates(t.start, t.end).length, "days to explore"],
    [t.items.length, "plans in place"],
    [t.items.filter((i) => i.status === "booked").length, "booked"],
    [
      `${t.packing.filter((p) => p.checked).length}/${t.packing.length}`,
      "packed",
    ],
  ]) {
    const s = el("span");
    append(
      s,
      el("strong", "", String(n)),
      document.createTextNode(" " + label),
    );
    summary.append(s);
  }
  for (const s of ["itinerary", "logistics", "packing", "budget", "links"]) {
    $(s + "-panel").hidden = section !== s;
    const b = document.querySelector(`[data-section="${s}"]`);
    if (section === s) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  renderAlerts(t);
  renderDates(t);
  renderDay(t);
  renderLogistics(t);
  renderPacking(t);
  renderBudget(t);
  renderLinks(t);
}
function renderAlerts(t) {
  const holder = $("planning-alerts"),
    wasOpen = holder.querySelector("details")?.open;
  holder.replaceChildren();
  const warnings = issues(t);
  if (!warnings.length) return;
  const detail = el("details", "planning-alerts");
  detail.open = wasOpen || false;
  append(
    detail,
    el(
      "summary",
      "",
      `${warnings.length} planning ${warnings.length === 1 ? "reminder" : "reminders"} · Check the small details`,
    ),
  );
  const ul = el("ul");
  for (const w of warnings) {
    const li = el("li");
    li.append(
      button(
        w.text,
        () => {
          section = "itinerary";
          setDay(w.date, true);
        },
        "",
      ),
    );
    ul.append(li);
  }
  detail.append(ul);
  holder.append(detail);
}
function renderDates(t) {
  const holder = $("date-tabs");
  holder.replaceChildren();
  const ds = dates(t.start, t.end);
  ds.forEach((d, index) => {
    const b = button(
      "",
      () => {
        setDay(d);
        $("date-" + d)?.focus({ preventScroll: true });
      },
      "date-tab",
    );
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", day === d);
    b.setAttribute("aria-controls", "day-items");
    b.id = `date-${d}`;
    b.tabIndex = day === d ? 0 : -1;
    b.setAttribute(
      "aria-label",
      dateLabel(d, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      }),
    );
    append(
      b,
      el("span", "", dateLabel(d, { weekday: "short" })),
      el("strong", "", d.slice(8)),
      el("span", "", dateLabel(d, { month: "short" })),
    );
    b.onkeydown = (e) => {
      let dest;
      if (e.key === "ArrowRight") dest = Math.min(ds.length - 1, index + 1);
      if (e.key === "ArrowLeft") dest = Math.max(0, index - 1);
      if (e.key === "Home") dest = 0;
      if (e.key === "End") dest = ds.length - 1;
      if (dest !== undefined) {
        e.preventDefault();
        setDay(ds[dest]);
        $(`date-${ds[dest]}`).focus({ preventScroll: true });
      }
    };
    holder.append(b);
  });
  const current = $("date-" + day);
  if (current) {
    holder.scrollLeft = Math.max(
      0,
      current.offsetLeft -
        holder.offsetLeft -
        holder.clientWidth / 2 +
        current.clientWidth / 2,
    );
  }
  $("prev-day").disabled = day === t.start;
  $("next-day").disabled = day === t.end;
  $("jump-date").min = t.start;
  $("jump-date").max = t.end;
  $("jump-date").value = day;
  $("day-items").setAttribute("aria-labelledby", `date-${day}`);
}
const kindLabels = {
  activity: "Activity",
  accommodation: "Accommodation",
  transport: "Transport",
};
function itemCard(i, fullDates = false) {
  const card = el("article", "timeline-card"),
    time = el("div", "time-column");
  append(
    time,
    el(
      "span",
      "",
      i.startTime || (i.kind === "accommodation" ? "Stay" : "Flexible"),
    ),
  );
  time.append(
    el(
      "small",
      "",
      i.endTime
        ? `to ${i.endTime}`
        : i.kind === "accommodation"
          ? "Check times"
          : "Time not set",
    ),
  );
  const copy = el("div", "item-copy"),
    top = el("div", "item-top");
  append(
    top,
    el("span", "item-type", kindLabels[i.kind]),
    el(
      "span",
      `status ${i.status}`,
      i.status === "booked" ? "✓ Booked" : "◇ Suggested",
    ),
  );
  append(
    copy,
    top,
    el("h3", "", i.title),
    el(
      "p",
      "item-location",
      i.location ? `⌖ ${i.location}` : "Location not added",
    ),
  );
  if (fullDates || i.startDate !== i.endDate)
    copy.append(
      el(
        "p",
        "item-details",
        `${dateLabel(i.startDate)} – ${dateLabel(i.endDate)}${i.kind === "accommodation" ? " · last date is checkout" : ""}`,
      ),
    );
  if (i.startTime)
    copy.append(
      el(
        "p",
        "item-details",
        `${i.timezone}${i.endTimezone !== i.timezone ? " → " + i.endTimezone : ""}${i.occurrence === "later" || i.endOccurrence === "later" ? " · later repeated clock occurrence" : ""}`,
      ),
    );
  if (i.notes) copy.append(el("p", "item-notes", i.notes));
  const actions = el("div", "item-actions");
  if (i.bookingURL) actions.append(link("Booking ↗", i.bookingURL));
  if (i.ticketURL) actions.append(link("Ticket ↗", i.ticketURL));
  actions.append(
    button("Edit", () => editItem(i), "text-button"),
    button(
      "Delete",
      () =>
        confirm(
          "Delete this plan?",
          `“${i.title}” will be removed from this trip.`,
          () =>
            updateTrip((t) => {
              t.items = t.items.filter((x) => x.id !== i.id);
              for (const e of t.expenses) if (e.planId === i.id) e.planId = "";
            }),
        ),
      "text-button danger",
    ),
  );
  append(copy, actions);
  renderAttachments(copy, i, fullDates);
  append(card, time, copy);
  return card;
}
function renderDay(t) {
  $("day-number").textContent =
    `DAY ${dates(t.start, day).length} OF ${dates(t.start, t.end).length}`;
  $("day-heading").textContent = dateLabel(day, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const items = filteredItems(t, day, query, status, kind),
    all = filteredItems(t, day);
  $("day-description").textContent =
    `${items.length} ${items.length === 1 ? "plan" : "plans"}${query || status !== "all" || kind !== "all" ? ` matching filters · ${all.length} total` : ""} · Times use the timezone shown on each plan.`;
  const holder = $("day-items");
  holder.replaceChildren();
  for (const i of items) holder.append(itemCard(i));
  if (!items.length) {
    if (all.length)
      empty(
        holder,
        "No matching plans",
        "Your filters are still on. Try a different search or clear them.",
        () => {
          query = "";
          status = "all";
          kind = "all";
          $("search").value = "";
          $("status-filter").value = "all";
          $("kind-filter").value = "all";
          render();
        },
        "Clear filters",
      );
    else
      empty(
        holder,
        "A day with room to explore",
        "Add a booking, a good idea or a little time to wander.",
        () => editItem(),
        "＋ Add your first plan",
      );
  }
}
function renderLogistics(t) {
  const h = $("logistics-items");
  h.replaceChildren();
  for (const i of t.items
    .filter((i) => i.kind !== "activity")
    .sort((a, b) => a.startDate.localeCompare(b.startDate)))
    h.append(itemCard(i, true));
  if (!h.children.length)
    empty(
      h,
      "Give the journey a home",
      "Add accommodation, arrival and departure transport. Suggested plans are welcome too.",
      () => editItem(null, "accommodation"),
      "＋ Add stay or travel",
    );
}
function rowActions(edit, remove) {
  return append(
    el("div", "row-actions"),
    button("Edit", edit, ""),
    button("Delete", remove, "danger"),
  );
}
function renderPacking(t) {
  $("packing-progress").textContent =
    `${t.packing.filter((p) => p.checked).length} of ${t.packing.length} packed · Check things off as you go.`;
  const h = $("packing-items");
  h.replaceChildren();
  for (const p of t.packing) {
    const r = el("div", "list-row"),
      l = el("label", "pack-label"),
      c = el("input");
    c.type = "checkbox";
    c.checked = p.checked;
    c.id = "pack-" + p.id;
    c.onchange = () => {
      try {
        updateTrip(
          (t) => (t.packing.find((x) => x.id === p.id).checked = c.checked),
        );
        $("pack-" + p.id)?.focus();
      } catch (e) {
        c.checked = !c.checked;
        notify(e.message);
      }
    };
    append(l, c, el("span", "", p.text));
    append(
      r,
      l,
      rowActions(
        () => editSimple("packing", p),
        () => removeSimple("packing", p),
      ),
    );
    h.append(r);
  }
  if (!t.packing.length)
    empty(
      h,
      "Pack a little peace of mind",
      "Keep essentials and nice-to-haves in a simple checklist.",
      () => editSimple("packing"),
      "＋ Add packing item",
    );
}
function renderBudget(t) {
  const h = $("budget-totals");
  h.replaceChildren();
  for (const [c, v] of Object.entries(totals(t))) {
    const hasBudget = t.budgets.some((b) => b.currency === c),
      box = el("div", "budget-total");
    append(
      box,
      el("span", "eyebrow", `${c} · TOTAL TRIP COST`),
      el("strong", "", money(v.total, c)),
      el("p", "", `${money(v.paid, c)} paid · ${money(v.planned, c)} planned`),
      el(
        "p",
        "",
        hasBudget ? `Budget ${money(v.budget, c)}` : "No budget limit set",
      ),
    );
    if (hasBudget)
      box.append(
        el(
          "p",
          v.total > v.budget ? "over" : "",
          v.total > v.budget
            ? `${money(v.total - v.budget, c)} over budget`
            : `${money(v.budget - v.total, c)} remaining`,
        ),
      );
    h.append(box);
  }
  for (const key of ["budgets", "expenses"]) {
    const list = $(key === "budgets" ? "budget-items" : "expense-items");
    list.replaceChildren();
    for (const e of t[key]) {
      const r = el("div", "list-row"),
        copy = el("div", "row-copy");
      append(
        copy,
        el("strong", "", e.title),
        el(
          "small",
          "",
          `${money(e.amount, e.currency)}${key === "expenses" ? ` · ${e.paymentStatus === "paid" ? "Paid" : "Planned"} · ${e.category} · ${dateLabel(e.date)}${e.planId ? " · " + (t.items.find((i) => i.id === e.planId)?.title || "") : ""}` : ""}`,
        ),
      );
      append(
        r,
        copy,
        rowActions(
          () => editSimple(key, e),
          () => removeSimple(key, e),
        ),
      );
      list.append(r);
    }
    if (!t[key].length)
      empty(
        list,
        key === "budgets" ? "A budget starts with a number" : "No costs yet",
        key === "budgets"
          ? "Add a limit for each currency you plan to spend."
          : "Track paid costs and planned amounts separately. Include the currency; totals never mix currencies.",
        () => editSimple(key),
        key === "budgets" ? "Set a budget" : "＋ Add cost",
      );
  }
}
function renderLinks(t) {
  const h = $("link-items");
  h.replaceChildren();
  for (const l of t.links) {
    const r = el("div", "list-row"),
      copy = el("div", "row-copy");
    append(
      copy,
      link(l.title + " ↗", l.url),
      el("small", "", new URL(l.url).hostname),
    );
    append(
      r,
      copy,
      rowActions(
        () => editSimple("links", l),
        () => removeSimple("links", l),
      ),
    );
    h.append(r);
  }
  if (!t.links.length)
    empty(
      h,
      "Keep the helpful things close",
      "Save maps, local guides and official information links.",
      () => editSimple("links"),
      "＋ Add a useful link",
    );
}
function removeSimple(key, item) {
  confirm(
    "Delete this item?",
    `“${item.text || item.title}” will be removed.`,
    () => updateTrip((t) => (t[key] = t[key].filter((x) => x.id !== item.id))),
  );
}
// Forms are built with DOM nodes. User text is never interpolated into markup.
function field(name, label, value = "", options = {}) {
  const wrapper = el("label", `field${options.wide ? " wide" : ""}`, label);
  let input;
  if (options.choices) {
    input = el("select");
    for (const [value, text] of options.choices) {
      const o = el("option", "", text);
      o.value = value;
      input.append(o);
    }
  } else input = el(options.type === "textarea" ? "textarea" : "input");
  if (input.tagName === "INPUT") input.type = options.type || "text";
  input.name = name;
  input.id = "field-" + name;
  input.value = String(value ?? "");
  for (const attr of [
    "required",
    "maxLength",
    "min",
    "max",
    "step",
    "placeholder",
  ])
    if (options[attr] !== undefined) input[attr] = options[attr];
  wrapper.append(input);
  if (options.hint) wrapper.append(el("small", "", options.hint));
  $("editor-fields").append(wrapper);
  return input;
}
function hint(text) {
  $("editor-fields").append(el("p", "form-hint", text));
}
function startEditor(title, build, save) {
  editorConfig = { save };
  $("editor-form").querySelector("button[type=submit]").disabled = false;
  $("editor-title").textContent = title;
  $("editor-fields").replaceChildren();
  $("editor-error").hidden = true;
  build();
  openDialog("editor");
}
$("editor-close").onclick = $("editor-cancel").onclick = () =>
  closeDialog("editor");
$("editor-form").onsubmit = async (e) => {
  e.preventDefault();
  const config = editorConfig,
    submit = e.target.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(e.target));
    await config.save(values);
    if (config === editorConfig && $("editor").open) {
      closeDialog("editor");
      notify(
        blockedStorage
          ? "Changes kept in this tab only. Download a backup."
          : "Saved on this device.",
      );
    }
  } catch (error) {
    if (config === editorConfig && $("editor").open) {
      $("editor-error").textContent = error.message;
      $("editor-error").hidden = false;
      $("editor-error").scrollIntoView({ block: "nearest" });
    }
  } finally {
    if (config === editorConfig) submit.disabled = false;
  }
};
function editTrip(existing) {
  const today = localToday(),
    defaults = existing || {
      name: "",
      destination: "",
      start: today,
      end: addDays(today, 2),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC",
      notes: "",
    };
  startEditor(
    existing ? "Edit trip" : "Create a trip",
    () => {
      field("name", "Trip name", defaults.name, {
        required: true,
        maxLength: 100,
        wide: true,
        placeholder: "A weekend away",
      });
      field("destination", "Destination", defaults.destination, {
        required: true,
        maxLength: 150,
        wide: true,
        placeholder: "City, region or country",
      });
      field("start", "First day", defaults.start, {
        type: "date",
        required: true,
        min: "1900-01-01",
        max: "2100-12-31",
      });
      field("end", "Last day", defaults.end, {
        type: "date",
        required: true,
        min: "1900-01-01",
        max: "2100-12-31",
      });
      field("timezone", "Destination timezone", defaults.timezone, {
        required: true,
        maxLength: 100,
        wide: true,
        hint: "IANA name, for example America/New_York, Europe/London or Asia/Tokyo. Each plan can use a different timezone.",
      });
      field("notes", "Trip notes", defaults.notes, {
        type: "textarea",
        maxLength: 5000,
        wide: true,
      });
      hint(
        "Trip dates include the first and last day, up to 366 days. Changing dates will not discard plans or expenses: move any out-of-range items first. Existing plan timezones stay as entered.",
      );
    },
    (v) => {
      const next = structuredClone(data);
      let t = next.trips.find((t) => t.id === existing?.id);
      if (t) Object.assign(t, v);
      else {
        t = {
          id: uid(),
          ...v,
          items: [],
          packing: [],
          expenses: [],
          budgets: [],
          links: [],
        };
        next.trips.push(t);
      }
      validate(next);
      commit(next);
      if (existing) render();
      else activateTrip(t.id);
    },
  );
}
function editItem(existing, defaultKind = "activity") {
  const t = trip(),
    i = existing || {
      kind: defaultKind,
      title: "",
      startDate: day,
      endDate: day,
      startTime: "",
      endTime: "",
      timezone: t.timezone,
      endTimezone: t.timezone,
      occurrence: "earlier",
      endOccurrence: "earlier",
      location: "",
      notes: "",
      status: "suggested",
      bookingURL: "",
      ticketURL: "",
    };
  startEditor(
    existing ? "Edit plan" : "Add a plan",
    () => {
      field("kind", "Type", i.kind, { choices: Object.entries(kindLabels) });
      field("status", "Status", i.status, {
        choices: [
          ["suggested", "Suggested"],
          ["booked", "Booked"],
        ],
      });
      field("title", "Plan title", i.title, {
        required: true,
        maxLength: 150,
        wide: true,
        placeholder: "Dinner, a train, a place to stay…",
      });
      field("startDate", "Start / check-in date", i.startDate, {
        type: "date",
        required: true,
        min: t.start,
        max: t.end,
      });
      field("endDate", "End / checkout date", i.endDate, {
        type: "date",
        required: true,
        min: t.start,
        max: t.end,
      });
      $("field-startDate").onchange = () => {
        if ($("field-endDate").value < $("field-startDate").value)
          $("field-endDate").value = $("field-startDate").value;
      };
      field("startTime", "Start time (optional)", i.startTime, {
        type: "time",
      });
      field("endTime", "End time (optional)", i.endTime, { type: "time" });
      hint(
        "Enter both times, or leave both blank for an unscheduled / all-day plan. Accommodation ends on the checkout date. For overnight travel, use the arrival date and timezone.",
      );
      field("timezone", "Start timezone", i.timezone, {
        required: true,
        maxLength: 100,
      });
      field("endTimezone", "End timezone", i.endTimezone, {
        required: true,
        maxLength: 100,
      });
      field("occurrence", "Repeated start time", i.occurrence, {
        choices: [
          ["earlier", "First occurrence"],
          ["later", "Second occurrence"],
        ],
      });
      field("endOccurrence", "Repeated end time", i.endOccurrence, {
        choices: [
          ["earlier", "First occurrence"],
          ["later", "Second occurrence"],
        ],
      });
      hint(
        "When clocks turn back, a time can occur twice. Choose the first or second occurrence. Times skipped when clocks move forward are rejected.",
      );
      field("location", "Location / address", i.location, {
        maxLength: 500,
        wide: true,
      });
      field("notes", "Notes", i.notes, {
        type: "textarea",
        maxLength: 5000,
        wide: true,
      });
      field("bookingURL", "Booking link", i.bookingURL, {
        type: "url",
        maxLength: 2000,
        wide: true,
        placeholder: "https://…",
      });
      field("ticketURL", "Ticket link", i.ticketURL, {
        type: "url",
        maxLength: 2000,
        wide: true,
        placeholder: "https://…",
      });
      hint(
        "Links remain in your browser and local exports. Booking and ticket URLs may be sensitive. Only http/https links without embedded credentials are accepted.",
      );
    },
    (v) =>
      updateTrip((t) => {
        const item = { id: existing?.id || uid(), ...v };
        const index = t.items.findIndex((x) => x.id === item.id);
        if (index < 0) t.items.push(item);
        else t.items[index] = item;
      }),
  );
}
function editSimple(key, existing) {
  const names = {
      packing: "packing item",
      expenses: "cost",
      budgets: "budget limit",
      links: "useful link",
    },
    t = trip();
  startEditor(
    `${existing ? "Edit" : "Add"} ${names[key]}`,
    () => {
      if (key === "packing")
        field("text", "Item", existing?.text || "", {
          required: true,
          maxLength: 200,
          wide: true,
          placeholder: "Something you do not want to forget",
        });
      else
        field("title", "Name", existing?.title || "", {
          required: true,
          maxLength: 150,
          wide: true,
        });
      if (key === "expenses" || key === "budgets") {
        field("amount", "Amount", existing?.amount ?? "", {
          type: "number",
          min: 0,
          max: 1e12,
          step: "any",
          required: true,
        });
        field("currency", "Currency code", existing?.currency || "USD", {
          required: true,
          maxLength: 3,
          placeholder: "USD, GBP, EUR…",
        });
        hint(
          "Use a valid three-letter currency code. Amounts use that currency’s decimal precision. Multiple budget limits in a currency are added together.",
        );
      }
      if (key === "expenses") {
        field(
          "paymentStatus",
          "Payment status",
          existing?.paymentStatus || "planned",
          {
            choices: [
              ["planned", "Planned / estimate"],
              ["paid", "Paid"],
            ],
          },
        );
        field("planId", "Linked plan (optional)", existing?.planId || "", {
          choices: [
            ["", "No linked plan"],
            ...t.items.map((i) => [i.id, i.title]),
          ],
        });
        hint(
          "Link this cost to a plan or booking for context. Linked costs count once here; plans do not add a second amount. Deleting a plan keeps its cost and removes the link.",
        );
        field("date", "Date", existing?.date || day, {
          type: "date",
          required: true,
          min: t.start,
          max: t.end,
        });
        field("category", "Category", existing?.category || "Other", {
          required: true,
          maxLength: 100,
        });
      }
      if (key === "links")
        field("url", "URL", existing?.url || "", {
          type: "url",
          required: true,
          maxLength: 2000,
          wide: true,
          placeholder: "https://…",
        });
    },
    (v) =>
      updateTrip((t) => {
        let record = { id: existing?.id || uid(), ...v };
        if (key === "packing") record.checked = existing?.checked || false;
        if (key === "expenses" || key === "budgets") {
          record.amount = Number(v.amount);
          record.currency = v.currency.trim().toUpperCase();
        }
        const index = t[key].findIndex((x) => x.id === record.id);
        if (index < 0) t[key].push(record);
        else t[key][index] = record;
      }),
  );
}
$("new-trip").onclick = $("welcome-create").onclick = () => editTrip();
$("edit-trip").onclick = () => editTrip(trip());
$("load-demo").onclick = () => {
  try {
    const t = demoTrip();
    commit({ version: 1, trips: [...data.trips, t] });
    activateTrip(t.id);
    notify("Fictional example added. No real trip data.");
  } catch (e) {
    notify(e.message);
  }
};
$("delete-trip").onclick = () =>
  confirm(
    "Delete this trip?",
    `“${trip().name}” and all its plans, packing, expenses and links will be removed from this browser. Download a backup first if you want to keep a copy.`,
    () =>
      commit({
        version: 1,
        trips: data.trips.filter((t) => t.id !== selected),
      }),
  );
$("add-activity").onclick = () => editItem();
$("add-logistics").onclick = () => editItem(null, "accommodation");
$("add-packing").onclick = () => editSimple("packing");
$("add-budget").onclick = () => editSimple("budgets");
$("add-expense").onclick = () => editSimple("expenses");
$("add-link").onclick = () => editSimple("links");
$("prev-day").onclick = () => setDay(addDays(day, -1));
$("next-day").onclick = () => setDay(addDays(day, 1));
$("jump-date").onchange = (e) => setDay(e.target.value);
$("search").oninput = (e) => {
  query = e.target.value;
  renderDay(trip());
};
$("status-filter").onchange = (e) => {
  status = e.target.value;
  renderDay(trip());
};
$("kind-filter").onchange = (e) => {
  kind = e.target.value;
  renderDay(trip());
};
$("section-nav").onclick = (e) => {
  const b = e.target.closest("[data-section]");
  if (b) {
    section = b.dataset.section;
    render();
    document.querySelector(`[data-section="${section}"]`).focus();
  }
};
function download(contents, type, name) {
  const url = URL.createObjectURL(new Blob([contents], { type })),
    a = el("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function openBackup() {
  importSequence++;
  pendingImport = null;
  $("import-preview").hidden = true;
  $("confirm-import").hidden = true;
  $("import-error").hidden = true;
  $("import-file").value = "";
  openDialog("backup-dialog");
}
$("backup-open").onclick = openBackup;
async function exportFullBackup() {
  try {
    if (!filesReady)
      throw Error(
        "File storage is unavailable. Use Download trip text only in Backup & privacy, or reload for a complete file backup.",
      );
    if (fileBusy)
      throw Error("Wait for the file operation to finish before backing up.");
    const snapshot = data,
      saved = lastSaved,
      revision = localStorage.getItem("personal-trip-planner.files-revision");
    notify("Preparing local backup including files…");
    const output = await portableBackup(snapshot, await files.list());
    if (
      data !== snapshot ||
      localStorage.getItem(STORAGE_KEY) !== saved ||
      localStorage.getItem("personal-trip-planner.files-revision") !==
        revision ||
      fileBusy
    )
      throw Error(
        "Plans or files changed while the backup was prepared. Please retry.",
      );
    download(output, "application/json", "personal-trip-planner-backup.json");
    notify("Trips and files backed up locally. Keep the file safe.");
  } catch (e) {
    notify(e.message);
  }
}
$("sidebar-backup").onclick = exportFullBackup;
$("export-backup").onclick = exportFullBackup;
$("backup-close").onclick = () => closeDialog("backup-dialog");
$("import-file").onchange = async (e) => {
  const sequence = ++importSequence;
  pendingImport = null;
  $("confirm-import").hidden = true;
  $("import-preview").hidden = true;
  $("import-error").hidden = true;
  const file = e.target.files[0];
  if (!file) return;
  try {
    if (file.size > MAX_BACKUP)
      throw Error("Full backup must be smaller than 32 MB.");
    const incoming = await readPortableBackup(await file.text());
    if (sequence !== importSequence) return;
    if (!incoming.planner.trips.length)
      throw Error("This backup has no trips to import.");
    remapImport(data, incoming);
    pendingImport = incoming;
    const h = $("import-preview");
    h.replaceChildren(
      el(
        "strong",
        "",
        `Ready to add ${incoming.planner.trips.length} trips and ${incoming.attachments.length} files:`,
      ),
    );
    for (const t of incoming.planner.trips)
      h.append(
        el(
          "p",
          "",
          `${t.name} · ${t.destination} · ${t.start} – ${t.end} · ${t.items.length} plans`,
        ),
      );
    h.hidden = false;
    $("confirm-import").hidden = false;
  } catch (error) {
    if (sequence !== importSequence) return;
    $("import-error").textContent = error.message;
    $("import-error").hidden = false;
  }
};
$("confirm-import").onclick = async () => {
  if (!pendingImport) return;
  if (fileBusy) {
    $("import-error").textContent =
      "Wait for the current file operation to finish.";
    $("import-error").hidden = false;
    return;
  }
  fileBusy++;
  const button = $("confirm-import"),
    sequence = importSequence,
    before = data;
  button.disabled = true;
  $("backup-close").disabled = true;
  $("import-file").disabled = true;
  let added = [],
    plannerCommitted = false;
  try {
    const next = remapImport(before, pendingImport),
      id = next.planner.trips[before.trips.length].id;
    if (next.attachments.length) {
      assertFileParent();
      await files.add(next.attachments);
      added = next.attachments.map((r) => r.id);
      if (data !== before)
        throw Error(
          "Plans changed during import. Retry to preserve your latest edits.",
        );
      persistRequired(next.planner);
    } else commit(next.planner);
    plannerCommitted = true;
    if (added.length) await files.finalize(added);
    announceFileChange();
    await refreshFiles();
    activateTrip(id);
    pendingImport = null;
    if (sequence === importSequence) closeDialog("backup-dialog");
    notify(
      blockedStorage
        ? "Imported in this tab only. Download a backup."
        : "Trips and files imported as separate copies. Existing trips kept.",
    );
  } catch (e) {
    if (!plannerCommitted && added.length)
      try {
        await files.remove(added);
      } catch {
        attachmentWarning(
          "Imported file rollback failed. Reload after ten minutes to clean up staged files.",
        );
      }
    if (plannerCommitted) {
      pendingImport = null;
      attachmentWarning(
        blockedStorage
          ? `Imported trip text is held in this tab only, but the view could not refresh. Download a text-only backup before closing or reloading. ${e.message}`
          : `Import was saved, but the view could not refresh. Reload to see the imported trips and files. ${e.message}`,
      );
    } else {
      $("import-error").textContent = e.message;
      $("import-error").hidden = false;
    }
  } finally {
    fileBusy--;
    button.disabled = false;
    $("backup-close").disabled = false;
    $("import-file").disabled = false;
    render();
    void cleanupAttachments();
  }
};
$("backup-dialog").addEventListener("cancel", (e) => {
  if ($("confirm-import").disabled) e.preventDefault();
});
$("calendar-export").onclick = () => {
  try {
    if (!trip().items.length) {
      notify("Add a plan before exporting a calendar.");
      return;
    }
    download(
      calendar(trip()),
      "text/calendar;charset=utf-8",
      "personal-trip-planner.ics",
    );
    notify("Calendar downloaded. Includes all plans, regardless of filters.");
  } catch (e) {
    notify(e.message);
  }
};
function buildPrint(t) {
  const p = $("print-view");
  p.replaceChildren(
    el("h1", "", t.name),
    el("p", "", `${t.destination} · ${t.start} – ${t.end} · ${t.timezone}`),
    el("p", "", t.notes),
  );
  p.append(
    el(
      "p",
      "",
      "Personal itinerary · Contains private travel information · Times use the timezone shown.",
    ),
  );
  for (const d of dates(t.start, t.end)) {
    p.append(
      el(
        "h2",
        "",
        dateLabel(d, {
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric",
        }),
      ),
    );
    const items = filteredItems(t, d);
    if (!items.length) p.append(el("p", "", "No plans recorded."));
    for (const i of items) {
      const a = el("article");
      append(
        a,
        el("h3", "", i.title),
        el(
          "p",
          "",
          `${kindLabels[i.kind]} · ${i.status} · ${i.startTime ? `${i.startDate} ${i.startTime} (${i.timezone}${i.occurrence === "later" ? ", second occurrence" : ""}) → ${i.endDate} ${i.endTime} (${i.endTimezone}${i.endOccurrence === "later" ? ", second occurrence" : ""})` : `Unscheduled / all day · ${i.startDate} – ${i.endDate}${i.kind === "accommodation" ? " (checkout)" : ""}`}`,
        ),
        el("p", "", i.location),
        el("p", "", i.notes),
      );
      for (const u of [i.bookingURL, i.ticketURL])
        if (u) a.append(el("p", "", u));
      p.append(a);
    }
  }
  p.append(el("h2", "", "Packing list"));
  for (const i of t.packing)
    p.append(el("p", "", `${i.checked ? "☑" : "☐"} ${i.text}`));
  p.append(el("h2", "", "Trip costs & budget"));
  for (const [c, v] of Object.entries(totals(t)))
    p.append(
      el(
        "p",
        "",
        `${c}: total ${money(v.total, c)}, paid ${money(v.paid, c)}, planned ${money(v.planned, c)}, budget limits ${money(v.budget, c)}. No currency conversion.`,
      ),
    );
  for (const e of t.expenses)
    p.append(
      el(
        "p",
        "",
        `${e.date} · ${e.title} · ${e.paymentStatus} · ${e.category} · ${money(e.amount, e.currency)}${e.planId ? " · " + (t.items.find((i) => i.id === e.planId)?.title || "") : ""}`,
      ),
    );
  p.append(el("h2", "", "Useful links"));
  for (const l of t.links) p.append(el("p", "", `${l.title}: ${l.url}`));
}
$("print-trip").onclick = () => {
  buildPrint(trip());
  window.print();
};
window.addEventListener("beforeprint", () => {
  if (trip()) buildPrint(trip());
});
window.addEventListener("afterprint", () => $("print-view").replaceChildren());
window.addEventListener("storage", (event) => {
  if (event.key === "personal-trip-planner.files-revision") {
    void refreshFiles().catch((e) =>
      attachmentWarning(`File refresh failed. Reload to retry. ${e.message}`),
    );
    return;
  }
  if (event.key !== STORAGE_KEY) return;
  storageWarning(
    "Plans changed in another tab. Reload this page before saving to avoid overwriting them. Download a backup first if you have unsaved changes.",
  );
});
if (blockedStorage) {
  const card = el("div", "backup-card");
  append(
    card,
    el("h3", "", "Recover browser storage"),
    el(
      "p",
      "",
      "Download the original stored content before resetting. Reset replaces this planner’s saved text with current in-memory trips. Connected sync will require recovery before continuing; account copies are kept.",
    ),
  );
  card.append(
    button("Download original storage", () => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw)
          download(
            raw,
            "application/json",
            "personal-trip-planner-recovery.json",
          );
        else notify("No saved content found.");
      } catch (e) {
        notify(e.message);
      }
    }),
    button(
      "Reset planner storage",
      () => {
        closeDialog("backup-dialog");
        confirm(
          "Reset planner storage?",
          "This removes the original saved planner data. Save the recovery file first. Current in-memory trips will replace it.",
          () => {
            localStorage.setItem("personal-trip-planner.sync-reset", uid());
            document.dispatchEvent(new Event("ptp-local-reset"));
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
            lastSaved = JSON.stringify(data);
            blockedStorage = false;
            $("storage-warning").hidden = true;
            card.remove();
          },
        );
      },
      "button destructive",
    ),
  );
  $("backup-dialog").append(card);
}
render();

void refreshFiles()
  .then(cleanupAttachments)
  .catch((e) =>
    attachmentWarning(
      `File storage is unavailable. Files cannot be added or included in backups. ${e.message}`,
    ),
  );

function attachmentWarning(text) {
  $("attachment-warning").textContent = text;
  $("attachment-warning").hidden = false;
}
function assertFileParent() {
  if (blockedStorage)
    throw Error(
      "Save planner data in browser storage before adding or importing files. Storage is currently unavailable; existing files are left untouched.",
    );
  if (localStorage.getItem(STORAGE_KEY) !== lastSaved)
    throw Error("Plans changed in another tab. Reload before changing files.");
  if (!filesReady)
    throw Error("File storage is not ready. Reload or try again.");
}
function persistRequired(next) {
  validate(next);
  assertFileParent();
  const raw = JSON.stringify(next);
  localStorage.setItem(STORAGE_KEY, raw);
  lastSaved = raw;
  data = next;
}
function announceFileChange() {
  document.dispatchEvent(new Event("ptp-local-change"));
  try {
    localStorage.setItem("personal-trip-planner.files-revision", uid());
  } catch {
    /* Main data is already saved; other tabs can reload file metadata. */
  }
}
async function refreshFiles() {
  attachmentRows = await files.list();
  filesReady = true;
  const keep = new Set(attachmentRows.map((r) => r.id));
  for (const [id, url] of fileURLs)
    if (!keep.has(id)) {
      URL.revokeObjectURL(url);
      fileURLs.delete(id);
    }
  render();
}
async function cleanupAttachments() {
  if (!filesReady || blockedStorage || fileBusy) return;
  try {
    const snapshot = lastSaved;
    if (localStorage.getItem(STORAGE_KEY) !== snapshot) return;
    const unused = attachmentRows.filter(
      (r) =>
        !ownedFiles(data, [r]).length &&
        (!r.pending || Date.now() - r.createdAt >= 10 * 60 * 1000),
    );
    if (!unused.length || localStorage.getItem(STORAGE_KEY) !== snapshot)
      return;
    await files.remove(unused.map((r) => r.id));
    await refreshFiles();
    announceFileChange();
  } catch (e) {
    attachmentWarning(
      `Unused files could not be removed. Reload to retry cleanup. ${e.message}`,
    );
  }
}
async function fileMutation(action) {
  if (fileBusy) throw Error("Wait for the current file operation to finish.");
  fileBusy++;
  try {
    return await action();
  } finally {
    fileBusy--;
    render();
    void cleanupAttachments();
  }
}
function fileURL(r) {
  if (!fileURLs.has(r.id)) fileURLs.set(r.id, URL.createObjectURL(r.blob));
  return fileURLs.get(r.id);
}
function downloadFile(r) {
  const a = el("a");
  a.href = fileURL(r);
  a.download = r.name;
  document.body.append(a);
  a.click();
  a.remove();
}
function renderAttachments(parent, item, fullDates) {
  const section = el("div", "attachments"),
    upload = el("label", "attachment-upload", "＋ Attach PDF / photo"),
    input = el("input", "sr-only");
  input.type = "file";
  input.multiple = true;
  input.accept = "application/pdf,image/png,image/jpeg,image/webp,image/gif";
  input.id = `files-${item.id}-${fullDates ? "logistics" : "day"}`;
  input.setAttribute("aria-label", `Attach PDF or photo to ${item.title}`);
  input.disabled = blockedStorage || !filesReady || fileBusy > 0;
  upload.append(input);
  input.onchange = async () => {
    if (!input.files.length) return;
    const chosen = [...input.files],
      tripId = selected;
    let added = [],
      saved = false;
    try {
      await fileMutation(async () => {
        assertFileParent();
        const rows = await makeRecords(chosen, tripId, item.id);
        assertFileParent();
        if (
          !data.trips.some(
            (t) => t.id === tripId && t.items.some((i) => i.id === item.id),
          )
        )
          throw Error("The owning plan was removed.");
        await files.add(rows);
        added = rows.map((r) => r.id);
        assertFileParent();
        if (
          !data.trips.some(
            (t) => t.id === tripId && t.items.some((i) => i.id === item.id),
          )
        )
          throw Error("The owning plan was removed.");
        await files.finalize(added);
        saved = true;
        announceFileChange();
        await refreshFiles();
        $("attachment-warning").hidden = true;
        notify("Files saved on this device. Include them in your backup.");
      });
    } catch (e) {
      if (added.length && !saved)
        try {
          await files.remove(added);
          await refreshFiles();
        } catch {
          attachmentWarning(
            "File rollback failed. Reload after ten minutes to retry cleanup.",
          );
        }
      attachmentWarning(
        saved
          ? `Files were saved but the view could not refresh. Reload. ${e.message}`
          : `Files were not saved: ${e.message}`,
      );
    } finally {
      input.value = "";
    }
  };
  section.append(upload);
  for (const r of attachmentRows.filter(
    (r) => r.tripId === selected && r.planId === item.id,
  )) {
    const row = el("div", "attachment-row");
    if (r.type.startsWith("image/")) {
      const img = el("img", "attachment-thumb");
      img.src = fileURL(r);
      img.alt = "";
      img.loading = "lazy";
      row.append(img);
    } else row.append(el("span", "attachment-icon", "PDF"));
    const copy = el("div", "row-copy");
    append(
      copy,
      el("strong", "", r.name),
      el(
        "small",
        "",
        `${r.type === "application/pdf" ? "PDF" : "Photo"} · ${(r.size / 1024).toFixed(1)} KB · Device only`,
      ),
    );
    const actions = el("div", "attachment-actions");
    append(
      actions,
      button("Preview", () => previewFile(r), "text-button"),
      button("Download", () => downloadFile(r), "text-button"),
      button(
        "Rename",
        () =>
          startEditor(
            "Rename file",
            () =>
              field("name", "File name", r.name, {
                required: true,
                maxLength: 120,
                wide: true,
              }),
            async (v) =>
              fileMutation(async () => {
                assertFileParent();
                await files.rename(r.id, filename(v.name, r.type));
                await refreshFiles();
                announceFileChange();
              }),
          ),
        "text-button",
      ),
      button(
        "Remove",
        () =>
          confirm(
            "Remove this file?",
            `${r.name} will be removed from this device. Download it or save a backup if you want a copy.`,
            async () =>
              fileMutation(async () => {
                assertFileParent();
                await files.remove([r.id]);
                await refreshFiles();
                announceFileChange();
              }),
          ),
        "text-button danger",
      ),
    );
    append(row, copy, actions);
    section.append(row);
  }
  parent.append(section);
}
$("attachment-preview-close").onclick = () => closeDialog("attachment-preview");
$("attachment-preview").addEventListener("close", () => {
  previewSequence++;
  previewRender?.cancel();
  void previewTask?.destroy().catch(() => {});
  previewTask = null;
  previewRender = null;
  $("attachment-preview-content").replaceChildren();
});
async function previewFile(r) {
  const sequence = ++previewSequence,
    current = () =>
      sequence === previewSequence && $("attachment-preview").open;
  $("attachment-preview-title").textContent = r.name;
  $("attachment-preview-status").textContent = "Loading local preview…";
  $("attachment-preview-content").replaceChildren();
  $("attachment-preview-actions").replaceChildren(
    button("Download original", () => downloadFile(r), "button primary"),
  );
  openDialog("attachment-preview");
  try {
    if (r.type !== "application/pdf") {
      const img = el("img", "file-preview-image");
      img.alt = r.name;
      img.src = fileURL(r);
      $("attachment-preview-content").append(img);
      $("attachment-preview-status").textContent =
        "Photo stored on this device.";
      return;
    }
    const pdfjs = await import("./vendor/pdf.mjs");
    if (!current()) return;
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "./vendor/pdf.worker.mjs",
      import.meta.url,
    ).href;
    const bytes = await r.blob.arrayBuffer();
    if (!current()) return;
    const task = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: true,
    });
    previewTask = task;
    const doc = await task.promise;
    if (!current() || previewTask !== task) {
      await task.destroy();
      return;
    }
    const page = await doc.getPage(1);
    if (!current()) return;
    const natural = page.getViewport({ scale: 1 }),
      viewport = page.getViewport({
        scale: Math.min(1.5, 1000 / natural.width, 1200 / natural.height),
      }),
      canvas = el("canvas", "file-preview-canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `First page of ${r.name}`);
    $("attachment-preview-content").append(canvas);
    previewRender = page.render({
      canvasContext: canvas.getContext("2d"),
      viewport,
    });
    await previewRender.promise;
    if (!current()) return;
    $("attachment-preview-status").textContent =
      `Page 1 of ${doc.numPages}. Download the original for all pages. Local preview only.`;
  } catch (e) {
    if (current())
      $("attachment-preview-status").textContent =
        `Preview unavailable. Download the original to view it in your PDF/photo viewer. ${e.name === "PasswordException" ? "This PDF requires a password." : e.message}`;
  }
}

$("export-text-only").onclick = () =>
  download(
    JSON.stringify(data),
    "application/json",
    "personal-trip-planner-text-only-backup.json",
  );

// Narrow, guarded projection bridge for the optional sync module. Auth sessions
// and cloud configuration never enter planner data or ordinary backups.
export const plannerBridge = {
  async snapshot() {
    assertFileParent();
    if (fileBusy || syncWriteBusy)
      throw Error("Wait for the current file/sync operation to finish.");
    const raw = lastSaved,
      revision = localStorage.getItem("personal-trip-planner.files-revision"),
      rows = await files.list(),
      fileMarker = await files.projectionMarker(),
      projectionMarker = localStorage.getItem(
        "personal-trip-planner.sync-projection",
      ),
      resetMarker = localStorage.getItem("personal-trip-planner.sync-reset");
    if (
      localStorage.getItem(STORAGE_KEY) !== raw ||
      localStorage.getItem("personal-trip-planner.files-revision") !== revision
    )
      throw Error("Plans/files changed in another tab. Reload before syncing.");
    if (rows.some((r) => r.pending))
      throw Error(
        "A file operation in this or another tab is still pending. Wait or reload before syncing.",
      );
    return {
      planner: structuredClone(data),
      records: ownedFiles(data, rows),
      token: {
        raw,
        revision,
        fileMarker,
        projectionMarker,
        resetMarker,
        fingerprint: fileFingerprint(rows),
        originalRows: rows,
      },
    };
  },
  async apply(next, token) {
    validate(next.planner);
    assertFileParent();
    if (
      fileBusy ||
      syncWriteBusy ||
      [...document.querySelectorAll("dialog[open]")].some(
        (d) => d.id !== "sync-dialog",
      )
    )
      throw Error(
        "Save/close open edits or file previews before applying sync changes. Your recovery copy is kept.",
      );
    if (
      localStorage.getItem("personal-trip-planner.sync-reset") !==
        token.resetMarker ||
      localStorage.getItem("personal-trip-planner.sync-projection") !==
        token.projectionMarker ||
      localStorage.getItem(STORAGE_KEY) !== token.raw ||
      localStorage.getItem("personal-trip-planner.files-revision") !==
        token.revision
    )
      throw Error(
        "Plans changed during sync. Device changes and recovery copies are kept; reload before continuing.",
      );
    syncWriteBusy = true;
    fileBusy++;
    let replaced = false;
    const projectionMarker = token.projectionMarker || uid();
    try {
      await files.replaceAll(
        next.records,
        token.fingerprint,
        projectionMarker,
        token.fileMarker,
      );
      replaced = true;
      if (
        localStorage.getItem("personal-trip-planner.sync-reset") !==
          token.resetMarker ||
        localStorage.getItem("personal-trip-planner.sync-projection") !==
          token.projectionMarker ||
        localStorage.getItem(STORAGE_KEY) !== token.raw ||
        localStorage.getItem("personal-trip-planner.files-revision") !==
          token.revision
      )
        throw Error(
          "Another tab edited during refresh. Those changes are kept; use the saved recovery copy if needed.",
        );
      const raw = JSON.stringify(next.planner);
      localStorage.setItem(
        "personal-trip-planner.sync-projection",
        projectionMarker,
      );
      localStorage.setItem(STORAGE_KEY, raw);
      data = structuredClone(next.planner);
      lastSaved = raw;
      for (const url of fileURLs.values()) URL.revokeObjectURL(url);
      fileURLs.clear();
      const t = data.trips.find((t) => t.id === selected) || data.trips[0];
      if (t) {
        if (t.id !== selected) restoreTrip(t.id);
        if (day < t.start || day > t.end) day = t.start;
      } else {
        selected = "";
        day = "";
      }
      await refreshFiles();
      announceFileChange();
    } catch (error) {
      // Roll back only our exact file projection. A concurrent edit prevents
      // rollback; the sync journal retains the complete original binary copy.
      if (replaced && localStorage.getItem(STORAGE_KEY) === token.raw) {
        try {
          await files.replaceAll(
            token.originalRows,
            fileFingerprint(next.records),
            token.fileMarker,
            projectionMarker,
          );
          if (token.projectionMarker)
            localStorage.setItem(
              "personal-trip-planner.sync-projection",
              token.projectionMarker,
            );
          else localStorage.removeItem("personal-trip-planner.sync-projection");
          await refreshFiles();
        } catch {
          attachmentWarning(
            "Device refresh failed and files changed concurrently. Download the private-sync recovery backup before continuing.",
          );
        }
      }
      throw error;
    } finally {
      syncWriteBusy = false;
      fileBusy--;
      render();
    }
  },
  subscribe(callback) {
    document.addEventListener("ptp-local-change", callback);
    return () => document.removeEventListener("ptp-local-change", callback);
  },
};
