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
for (const id of ["editor", "backup-dialog", "confirm-dialog"]) {
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
$("confirm-delete").onclick = () => {
  closeDialog("confirm-dialog");
  try {
    confirmAction();
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
  $("editor-title").textContent = title;
  $("editor-fields").replaceChildren();
  $("editor-error").hidden = true;
  build();
  openDialog("editor");
}
$("editor-close").onclick = $("editor-cancel").onclick = () =>
  closeDialog("editor");
$("editor-form").onsubmit = (e) => {
  e.preventDefault();
  try {
    const values = Object.fromEntries(new FormData(e.target));
    editorConfig.save(values);
    closeDialog("editor");
    notify(
      blockedStorage
        ? "Changes kept in this tab only. Download a backup."
        : "Saved on this device.",
    );
  } catch (error) {
    $("editor-error").textContent = error.message;
    $("editor-error").hidden = false;
    $("editor-error").scrollIntoView({ block: "nearest" });
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
$("sidebar-backup").onclick = () =>
  download(
    JSON.stringify(data),
    "application/json",
    "personal-trip-planner-backup.json",
  );
$("backup-close").onclick = () => closeDialog("backup-dialog");
$("export-backup").onclick = () => {
  download(
    JSON.stringify(data),
    "application/json",
    "personal-trip-planner-backup.json",
  );
  notify("Local backup downloaded. Keep it somewhere safe.");
};
$("import-file").onchange = async (e) => {
  const sequence = ++importSequence;
  pendingImport = null;
  $("confirm-import").hidden = true;
  $("import-preview").hidden = true;
  $("import-error").hidden = true;
  const file = e.target.files[0];
  if (!file) return;
  try {
    if (file.size > 2 * 1024 * 1024)
      throw Error("Backup must be smaller than 2 MB.");
    const incoming = parseBackup(await file.text());
    if (sequence !== importSequence) return;
    if (!incoming.trips.length)
      throw Error("This backup has no trips to import.");
    mergeBackup(data, incoming);
    pendingImport = incoming;
    const h = $("import-preview");
    h.replaceChildren(
      el(
        "strong",
        "",
        `Ready to add ${incoming.trips.length} ${incoming.trips.length === 1 ? "trip" : "trips"}:`,
      ),
    );
    for (const t of incoming.trips)
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
$("confirm-import").onclick = () => {
  if (!pendingImport) return;
  try {
    const next = mergeBackup(data, pendingImport),
      id = next.trips[data.trips.length].id;
    commit(next);
    activateTrip(id);
    pendingImport = null;
    closeDialog("backup-dialog");
    notify(
      blockedStorage
        ? "Imported in this tab only. Download a backup."
        : "Imported as separate copies. Existing trips kept.",
    );
  } catch (e) {
    $("import-error").textContent = e.message;
    $("import-error").hidden = false;
  }
};
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
      "Download the original stored content before resetting. Reset removes only this planner’s storage key; current in-memory trips will be saved.",
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
