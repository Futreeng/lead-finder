// Lead Finder app. Plain JavaScript, no build step. All firm data is inserted as text, never as HTML.
"use strict";

const TOKEN = document.querySelector('meta[name="lf-token"]').content;
const ACTION_ONLY = ["Needs review", "Speed check approved", "Report sent", "Opted out", "Rejected"];
const TABS = [
  ["today", "Today"],
  ["review", "Review"],
  ["tracker", "Tracker"],
  ["find", "Find firms"],
  ["numbers", "Numbers"],
  ["settings", "Settings"],
];

let S = null; // last /api/state
let tab = "today";
let openFirmId = null;
let pollTimer = null;
const trackerFilter = { status: "", text: "" };
const findForm = { useNear: true, lat: "41.08", lon: "-81.52", radiusKm: "15", limit: "", seedCsv: "", seedName: "" };

// ---------- helpers ----------
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v; // CSSOM, allowed by the page's content security policy
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function toast(msg, isError) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = isError ? "toast error" : "toast";
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), isError ? 7000 : 3000);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "x-lf-token": TOKEN, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

async function act(fn, okMsg) {
  try {
    const out = await fn();
    await refresh();
    if (okMsg) toast(okMsg);
    return out;
  } catch (err) {
    toast(err.message, true);
    return undefined;
  }
}

function firmById(id) {
  return S.firms.find((f) => f.id === id);
}

function pillClass(status) {
  if (status === "Needs review") return "pill review";
  if (status === "Signed" || status === "Call booked" || status === "Proposal sent") return "pill good";
  if (status === "Opted out" || status === "Rejected") return "pill stop";
  return "pill";
}

function pill(status) {
  return h("span", { class: pillClass(status) }, status);
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : iso;
}

function pct(v) {
  return v === null || v === undefined ? "not enough data" : `${Math.round(v * 100)}%`;
}

function safeHref(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function askPin(title) {
  return new Promise((resolve) => {
    const dlg = document.getElementById("dlg");
    const input = h("input", { type: "password", autocomplete: "off", "aria-label": "Approver PIN" });
    const form = h(
      "form",
      { method: "dialog" },
      h("h3", {}, title),
      h("p", { class: "muted" }, "Only the approver should type this PIN."),
      h("label", {}, "Approver PIN"),
      input,
      h(
        "div",
        { class: "row" },
        h("button", { class: "btn primary", value: "ok" }, "Approve"),
        h("button", { class: "btn", value: "cancel", type: "button", onclick: () => dlg.close("cancel") }, "Cancel"),
      ),
    );
    dlg.replaceChildren(form);
    dlg.onclose = () => resolve(dlg.returnValue === "ok" ? input.value : null);
    dlg.returnValue = "";
    dlg.showModal();
    input.focus();
  });
}

function confirmBox(title, text, yes) {
  return new Promise((resolve) => {
    const dlg = document.getElementById("dlg");
    dlg.replaceChildren(
      h(
        "form",
        { method: "dialog" },
        h("h3", {}, title),
        h("p", {}, text),
        h(
          "div",
          { class: "row" },
          h("button", { class: "btn danger", value: "ok" }, yes),
          h("button", { class: "btn", value: "cancel" }, "Cancel"),
        ),
      ),
    );
    dlg.onclose = () => resolve(dlg.returnValue === "ok");
    dlg.returnValue = "";
    dlg.showModal();
  });
}

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    toast("Could not copy. Select the text and press Ctrl+C.", true);
  }
}

// ---------- shell ----------
async function refresh() {
  S = await api("GET", "/api/state");
  renderTabs();
  renderSwitch();
  renderMain();
  if (openFirmId) renderPanel();
}

function renderTabs() {
  const nav = document.getElementById("tabs");
  nav.replaceChildren(
    ...TABS.map(([id, label]) =>
      h(
        "button",
        { "aria-current": tab === id ? "page" : null, onclick: () => setTab(id) },
        label,
        id === "review" && S.today.review ? h("span", { class: "count" }, S.today.review) : null,
      ),
    ),
  );
}

function renderSwitch() {
  const el = document.getElementById("switch");
  if (S.offSwitch) {
    el.replaceChildren(
      h("span", { class: "pill stop" }, "Off switch ON"),
      h("span", { class: "muted" }, "Website checks are blocked. Delete the STOP file to allow them."),
    );
  } else {
    el.replaceChildren(
      h("span", { class: "pill good" }, "Searching allowed"),
      h(
        "button",
        {
          class: "btn danger",
          onclick: async () => {
            if (await confirmBox("Turn on the off switch?", "This blocks all website checks until someone deletes the STOP file in the project folder.", "Turn it on")) {
              act(() => api("POST", "/api/offswitch", {}), "Off switch is on");
            }
          },
        },
        "Off switch",
      ),
    );
  }
}

function setTab(id) {
  tab = id;
  renderTabs();
  renderMain();
  document.getElementById("main").focus();
}

function renderMain() {
  const main = document.getElementById("main");
  const views = { today: viewToday, review: viewReview, tracker: viewTracker, find: viewFind, numbers: viewNumbers, settings: viewSettings };
  main.replaceChildren(views[tab]());
}

function firmLink(f) {
  return h("button", { class: "linkish", onclick: () => openFirm(f.id) }, f.firm);
}

// ---------- Today ----------
function viewToday() {
  const t = S.today;
  const card = (title, items, empty) =>
    h("section", { class: "card" }, h("h3", {}, title), items.length ? h("ul", { class: "list" }, items) : h("p", { class: "muted" }, empty));
  const draftItem = ({ firmId, draftId }) => {
    const f = firmById(firmId);
    const d = f && f.drafts.find((x) => x.id === draftId);
    return f && d ? h("li", {}, firmLink(f), h("div", { class: "muted" }, S.draftKinds[d.kind], ": ", d.subject)) : null;
  };
  const setupMissing = [];
  if (!S.settings.pinSet) setupMissing.push("set an approver PIN");
  if (!S.settings.senderName || !S.settings.mailingAddress) setupMissing.push("fill in your name and mailing address");
  return h(
    "div",
    {},
    setupMissing.length
      ? h("div", { class: "problems" }, h("strong", {}, "Before you start: "), `go to Settings and ${setupMissing.join(" and ")}.`)
      : null,
    h(
      "div",
      { class: "grid" },
      card(
        "Review queue",
        t.review ? [h("li", {}, h("button", { class: "linkish", onclick: () => setTab("review") }, `${t.review} firm(s) waiting for review`))] : [],
        "Nothing waiting.",
      ),
      card("Emails waiting for approval", t.toApprove.map(draftItem).filter(Boolean), "None."),
      card("Approved, ready to copy and send", t.toSend.map(draftItem).filter(Boolean), "None."),
      card(
        "Next steps due",
        t.due.map((id) => {
          const f = firmById(id);
          return h("li", {}, firmLink(f), h("div", { class: "muted" }, `${f.nextStep || "Next step"} (due ${f.nextStepDate})`));
        }),
        "Nothing due today.",
      ),
      card(
        "Speed checks in progress",
        t.reports.map((id) => {
          const f = firmById(id);
          const st = f.speedCheck.reportState === "approved" ? "report approved, not sent yet" : "report not approved yet";
          return h("li", {}, firmLink(f), h("div", { class: "muted" }, st));
        }),
        "None.",
      ),
    ),
  );
}

// ---------- Review ----------
function viewReview() {
  const queue = S.firms.filter((f) => f.status === "Needs review");
  if (!queue.length) return h("div", { class: "card" }, h("h2", {}, "Review queue"), h("p", { class: "muted" }, "No firms waiting. Use Find firms to look for more."));
  return h(
    "div",
    {},
    h("h2", {}, `Review queue (${queue.length})`),
    h("p", { class: "muted" }, "Check each firm's website yourself. Accept it only if it really is a 2 to 10 attorney firm doing estate planning or similar work."),
    ...queue.map((f) => {
      const reason = h("input", { placeholder: "Why reject? (for example, personal injury only)", style: "flex:1;min-width:200px" });
      const href = safeHref(f.website);
      return h(
        "section",
        { class: "card", style: "margin-bottom:12px" },
        h("div", { class: "row", style: "justify-content:space-between" }, h("h3", { style: "margin:0" }, f.firm), h("button", { class: "btn", onclick: () => openFirm(f.id) }, "Open")),
        h(
          "div",
          { class: "muted" },
          href ? h("a", { href, target: "_blank", rel: "noopener noreferrer" }, f.website) : "No website",
          f.phone ? ` | ${f.phone}` : "",
          ` | Attorneys: ${f.attorneys || "unknown"}`,
        ),
        f.practiceArea ? h("div", {}, "Practice keywords found: ", f.practiceArea) : null,
        f.foundNote ? h("div", { class: "note", style: "margin-top:6px" }, f.foundNote) : null,
        h("div", { class: "muted", style: "font-size:12px;margin-top:4px" }, "Source: ", f.source),
        h(
          "div",
          { class: "row" },
          h("button", { class: "btn primary", onclick: () => act(() => api("POST", `/api/firms/${f.id}/review`, { decision: "accept" }), `${f.firm} accepted`) }, "Accept"),
          reason,
          h("button", { class: "btn danger", onclick: () => act(() => api("POST", `/api/firms/${f.id}/review`, { decision: "reject", reason: reason.value }), `${f.firm} rejected`) }, "Reject"),
        ),
      );
    }),
  );
}

// ---------- Tracker ----------
function viewTracker() {
  const tbody = h("tbody");
  const fill = () => {
    const text = trackerFilter.text.toLowerCase();
    const rows = S.firms
      .filter((f) => !trackerFilter.status || f.status === trackerFilter.status)
      .filter((f) => !text || `${f.firm} ${f.website} ${f.contact} ${f.notes}`.toLowerCase().includes(text))
      .sort((a, b) => S.statuses.indexOf(a.status) - S.statuses.indexOf(b.status) || a.firm.localeCompare(b.firm));
    tbody.replaceChildren(
      ...rows.map((f) =>
        h(
          "tr",
          { onclick: () => openFirm(f.id), tabindex: "0", onkeydown: (e) => e.key === "Enter" && openFirm(f.id) },
          h("td", {}, f.firm),
          h("td", {}, pill(f.status)),
          h("td", {}, f.attorneys),
          h("td", {}, f.practiceArea),
          h("td", {}, f.lastContact),
          h("td", {}, f.nextStep, f.nextStepDate ? ` (${f.nextStepDate})` : ""),
        ),
      ),
    );
    if (!rows.length) tbody.append(h("tr", {}, h("td", { colspan: "6", class: "muted" }, "No firms match.")));
  };
  fill();
  const statusSel = h(
    "select",
    { "aria-label": "Filter by status", onchange: (e) => ((trackerFilter.status = e.target.value), fill()) },
    h("option", { value: "" }, "All statuses"),
    ...S.statuses.map((s) => h("option", { value: s, selected: trackerFilter.status === s }, s)),
  );
  const search = h("input", { type: "search", placeholder: "Search firms", value: trackerFilter.text, oninput: (e) => ((trackerFilter.text = e.target.value), fill()) });
  const file = h("input", {
    type: "file",
    accept: ".csv,text/csv",
    hidden: true,
    onchange: async (e) => {
      const fl = e.target.files[0];
      if (!fl) return;
      const csv = await fl.text();
      const r = await act(() => api("POST", "/api/import", { csv, name: fl.name }));
      if (r) toast(`Imported ${r.added} firm(s) (${r.optedOut} kept as opted out). ${r.alreadyThere} were already here.`);
      e.target.value = "";
    },
  });
  return h(
    "div",
    {},
    h("h2", {}, `Tracker (${S.firms.length})`),
    h(
      "div",
      { class: "row" },
      statusSel,
      search,
      h("button", { class: "btn", onclick: addFirmDialog }, "Add a firm"),
      h("button", { class: "btn", onclick: () => file.click() }, "Import CSV"),
      file,
      h("a", { class: "btn", href: `/export.csv?t=${encodeURIComponent(TOKEN)}` }, "Export CSV (for Google Sheets)"),
    ),
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, ...["Firm", "Status", "Attorneys", "Practice area", "Last contact", "Next step"].map((x) => h("th", {}, x)))),
        tbody,
      ),
    ),
  );
}

function addFirmDialog() {
  const dlg = document.getElementById("dlg");
  const fields = { firm: "Firm name", website: "Website", contact: "Contact (name, title)", phone: "Phone", attorneys: "Attorneys", practiceArea: "Practice area" };
  const inputs = {};
  const form = h(
    "form",
    {
      method: "dialog",
      onsubmit: async (e) => {
        if (e.submitter && e.submitter.value === "cancel") return;
        e.preventDefault();
        const body = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
        const r = await act(() => api("POST", "/api/firms", body), "Firm added");
        if (r) {
          dlg.close();
          openFirm(r.id);
        }
      },
    },
    h("h3", {}, "Add a firm you found yourself"),
    ...Object.entries(fields).map(([k, label]) => [h("label", {}, label), (inputs[k] = h("input", { style: "width:100%" }))]),
    h("p", { class: "muted" }, "Firms you add by hand skip the review queue, so check them first."),
    h("div", { class: "row" }, h("button", { class: "btn primary", value: "ok" }, "Add"), h("button", { class: "btn", value: "cancel" }, "Cancel")),
  );
  dlg.replaceChildren(form);
  dlg.onclose = null;
  dlg.showModal();
  inputs.firm.focus();
}

// ---------- Find firms ----------
function viewFind() {
  const job = S.job;
  const running = job && job.state === "running";
  const f = findForm;
  const bind = (k) => (e) => (f[k] = e.target.type === "checkbox" ? e.target.checked : e.target.value);
  const seedFile = h("input", {
    type: "file",
    accept: ".csv,text/csv",
    onchange: async (e) => {
      const fl = e.target.files[0];
      if (!fl) return;
      f.seedCsv = await fl.text();
      f.seedName = fl.name;
      renderMain();
    },
  });
  const form = h(
    "section",
    { class: "card" },
    h("h2", {}, "Find firms"),
    h("p", { class: "muted" }, "Finds law offices, checks each firm's own website politely, and puts likely fits in the review queue. It never contacts a firm."),
    h("label", {}, h("input", { type: "checkbox", checked: f.useNear, onchange: bind("useNear") }), " Look up law offices on OpenStreetMap near a point"),
    h(
      "div",
      { class: "form-grid" },
      h("div", {}, h("label", {}, "Latitude"), h("input", { value: f.lat, oninput: bind("lat") })),
      h("div", {}, h("label", {}, "Longitude"), h("input", { value: f.lon, oninput: bind("lon") })),
      h("div", {}, h("label", {}, "Radius (km, up to 50)"), h("input", { value: f.radiusKm, oninput: bind("radiusKm") })),
      h("div", {}, h("label", {}, "Check at most (blank for all)"), h("input", { value: f.limit, oninput: bind("limit") })),
    ),
    h("p", { class: "muted" }, "41.08, -81.52 is roughly downtown Akron."),
    h("label", {}, "And/or a list of firms you found by hand (CSV with a Firm column and ideally a Website column)"),
    seedFile,
    f.seedName ? h("div", { class: "muted" }, `Loaded: ${f.seedName}`, " ", h("button", { class: "linkish", onclick: () => ((f.seedCsv = ""), (f.seedName = ""), renderMain()) }, "remove")) : null,
    h(
      "div",
      { class: "row" },
      h(
        "button",
        {
          class: "btn primary",
          disabled: running || Boolean(S.offSwitch),
          onclick: () => {
            const body = { limit: f.limit.trim() || undefined };
            if (f.useNear) body.near = { lat: f.lat, lon: f.lon, radiusKm: f.radiusKm };
            if (f.seedCsv) {
              body.seedCsv = f.seedCsv;
              body.seedName = f.seedName;
            }
            act(() => api("POST", "/api/search", body), "Search started").then(startPolling);
          },
        },
        running ? "Searching..." : "Start search",
      ),
      S.offSwitch ? h("span", { class: "pill stop" }, "Off switch is on") : null,
    ),
  );
  return h("div", {}, form, job ? jobView(job) : null);
}

function jobView(job) {
  const log = h("pre", { class: "log" }, job.log.join("\n"));
  setTimeout(() => (log.scrollTop = log.scrollHeight), 0);
  const label = { running: "Running", done: "Finished", stopped: "Stopped by the off switch", failed: "Failed" }[job.state];
  return h(
    "section",
    { class: "card", style: "margin-top:12px" },
    h("h3", {}, `Last search: ${label}`),
    job.error ? h("div", { class: "problems" }, job.error) : null,
    job.state !== "running"
      ? h(
          "div",
          { class: "ok-box" },
          `${job.added} firm(s) added to the review queue. ${job.alreadyThere} were already in the app. `,
          job.added ? h("button", { class: "linkish", onclick: () => setTab("review") }, "Go to review") : null,
        )
      : null,
    log,
    job.skipped.length
      ? h(
          "div",
          {},
          h("h3", {}, `Skipped (${job.skipped.length})`),
          h("p", { class: "muted" }, "Firms with no website listed can still be good fits. Add one for review if you want to research it by hand."),
          h(
            "div",
            { class: "table-wrap" },
            h(
              "table",
              {},
              h("thead", {}, h("tr", {}, h("th", {}, "Firm"), h("th", {}, "Why skipped"), h("th", {}, ""))),
              h(
                "tbody",
                {},
                ...job.skipped.map((s, i) =>
                  h(
                    "tr",
                    {},
                    h("td", {}, s.firm, s.website ? h("div", { class: "muted" }, s.website) : null),
                    h("td", {}, s.reason),
                    h(
                      "td",
                      {},
                      s.added
                        ? h("span", { class: "muted" }, "Added")
                        : h("button", { class: "btn", onclick: () => act(() => api("POST", "/api/search/add", { index: i }), "Added for review") }, "Add for review"),
                    ),
                  ),
                ),
              ),
            ),
          ),
        )
      : null,
  );
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const job = await api("GET", "/api/search");
      if (S) S.job = job;
      if (tab === "find") renderMain();
      if (!job || job.state !== "running") {
        clearInterval(pollTimer);
        await refresh();
      }
    } catch (err) {
      clearInterval(pollTimer);
      toast(err.message, true);
    }
  }, 1500);
}

// ---------- Numbers ----------
function viewNumbers() {
  const m = S.metrics;
  const rows = [
    ["Firms added (accepted from review or added by hand)", "firmsAdded"],
    ["First emails sent", "firstEmails"],
    ["Follow-ups sent", "followUps"],
    ["Replies", "replies"],
    ["Speed checks approved by firms", "speedChecksApproved"],
    ["Reports sent", "reportsSent"],
    ["Calls booked", "callsBooked"],
    ["Proposals sent", "proposalsSent"],
    ["Signed", "signed"],
    ["Opted out", "optedOut"],
  ];
  return h(
    "div",
    {},
    h("h2", {}, "Numbers for the Friday review"),
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, h("th", {}, "Measure"), h("th", {}, `This week (since ${new Date(m.weekStart).toLocaleDateString()})`), h("th", {}, "All time"))),
        h("tbody", {}, ...rows.map(([label, k]) => h("tr", { style: "cursor:default" }, h("td", {}, label), h("td", {}, m.thisWeek[k]), h("td", {}, m.allTime[k])))),
      ),
    ),
    h(
      "div",
      { class: "grid", style: "margin-top:12px" },
      ...[
        ["Reply rate", m.rates.replyRate, "replies divided by first emails"],
        ["Speed check yes rate", m.rates.speedCheckYesRate, "firms that agreed divided by replies"],
        ["Call rate", m.rates.callRate, "calls booked divided by reports sent"],
        ["Close rate", m.rates.closeRate, "signed divided by proposals sent"],
      ].map(([label, v, how]) =>
        h("section", { class: "card" }, h("div", { class: "muted" }, label), v === null ? h("div", { class: "muted" }, "No data yet") : h("div", { class: "stat" }, pct(v)), h("div", { class: "muted", style: "font-size:12px" }, how)),
      ),
    ),
    h("p", { class: "muted" }, "When one rate is low, fix that stage first. A low reply rate means work on the email. A low call rate means work on the report."),
  );
}

// ---------- Settings ----------
function viewSettings() {
  const s = S.settings;
  const fields = [
    ["senderName", "Your name (signs the emails)"],
    ["senderTitle", "Your title"],
    ["company", "Company"],
    ["city", "City"],
    ["phone", "Phone"],
    ["email", "Work email"],
    ["mailingAddress", "Mailing address (required in every cold email)"],
    ["approverName", "Approver name (who types the PIN)"],
  ];
  const inputs = {};
  const oldPin = h("input", { type: "password", autocomplete: "off" });
  const newPin = h("input", { type: "password", autocomplete: "new-password" });
  return h(
    "div",
    {},
    h(
      "section",
      { class: "card" },
      h("h2", {}, "Settings"),
      h("div", { class: "form-grid" }, ...fields.map(([k, label]) => h("div", {}, h("label", {}, label), (inputs[k] = h("input", { value: s[k] || "" }))))),
      h(
        "div",
        { class: "row" },
        h("button", { class: "btn primary", onclick: () => act(() => api("PUT", "/api/settings", Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]))), "Settings saved") }, "Save settings"),
      ),
    ),
    h(
      "section",
      { class: "card", style: "margin-top:12px" },
      h("h3", {}, s.pinSet ? "Change the approver PIN" : "Set the approver PIN"),
      h("p", { class: "muted" }, "Emails and reports can only be approved with this PIN. Give it only to the person who approves outreach."),
      s.pinSet ? [h("label", {}, "Current PIN"), oldPin] : null,
      h("label", {}, "New PIN (at least 4 characters)"),
      newPin,
      h(
        "div",
        { class: "row" },
        h("button", { class: "btn primary", onclick: () => act(() => api("POST", "/api/settings/pin", { newPin: newPin.value, oldPin: oldPin.value }), "PIN saved") }, "Save PIN"),
      ),
    ),
    h(
      "section",
      { class: "card", style: "margin-top:12px" },
      h("h3", {}, "Safety"),
      h("p", {}, "This app only runs on this computer and never sends email, fills in forms, or calls anyone. A person copies each approved email into Outlook and sends it."),
      h("p", {}, "Off switch: the Off switch button (top right) or a file named STOP in the project folder blocks every website check until the file is deleted."),
      h("p", { class: "muted" }, "Your data is saved in data/lead-finder.json in the project folder, with a daily copy in data/backups."),
    ),
  );
}

// ---------- Firm panel ----------
function openFirm(id) {
  openFirmId = id;
  renderPanel();
}

function closePanel() {
  openFirmId = null;
  document.getElementById("panel").hidden = true;
}

function renderPanel() {
  const panel = document.getElementById("panel");
  const f = firmById(openFirmId);
  if (!f) return closePanel();
  panel.hidden = false;
  const href = safeHref(f.website);
  const blocked = ["Needs review", "Rejected", "Opted out"].includes(f.status);

  const statusSel = h(
    "select",
    {
      "aria-label": "Status",
      onchange: async (e) => {
        const to = e.target.value;
        let pin;
        if (f.status === "Opted out") {
          pin = await askPin("Undo this opt-out?");
          if (pin === null) return renderPanel();
        }
        act(() => api("POST", `/api/firms/${f.id}/status`, { status: to, pin }), `Status: ${to}`);
      },
    },
    ...S.statuses.map((s) => h("option", { value: s, selected: s === f.status, disabled: s !== f.status && ACTION_ONLY.includes(s) }, s)),
  );

  const parts = [
    h("button", { class: "btn close", onclick: closePanel, "aria-label": "Close" }, "Close"),
    h("h2", {}, f.firm),
    h(
      "div",
      { class: "row" },
      pill(f.status),
      href ? h("a", { href, target: "_blank", rel: "noopener noreferrer" }, f.website) : h("span", { class: "muted" }, "No website"),
      f.phone ? h("span", {}, f.phone) : null,
      f.publicEmail ? h("span", {}, f.publicEmail) : null,
    ),
    f.status === "Needs review"
      ? h("div", { class: "problems" }, "This firm is waiting in the review queue. Accept or reject it there before anything else.")
      : h(
          "div",
          { class: "row" },
          h("label", { style: "margin:0" }, "Status"),
          statusSel,
          h(
            "button",
            {
              class: "btn",
              disabled: blocked,
              onclick: async () => {
                const note = window.prompt("What did they say? (optional)");
                if (note === null) return;
                act(() => api("POST", `/api/firms/${f.id}/reply`, { note }), "Reply logged");
              },
            },
            "Log a reply",
          ),
          f.status !== "Opted out"
            ? h(
                "button",
                {
                  class: "btn danger",
                  onclick: async () => {
                    if (await confirmBox("Mark as opted out?", `${f.firm} will never be contacted again and unsent drafts are deleted.`, "Opted out")) {
                      act(() => api("POST", `/api/firms/${f.id}/optout`, {}), "Marked opted out");
                    }
                  },
                },
                "Opted out",
              )
            : null,
        ),
    detailsSection(f),
    f.foundNote ? [h("h3", {}, "What the finder noted"), h("div", { class: "note" }, f.foundNote)] : null,
    emailsSection(f, blocked),
    speedCheckSection(f, blocked),
    timelineSection(f),
  ];
  // replaceChildren would print "null" for empty parts, so drop them first.
  panel.replaceChildren(...parts.flat().filter((x) => x !== null && x !== undefined && x !== false));
}

function detailsSection(f) {
  const fields = [
    ["firm", "Firm"],
    ["contact", "Contact (name, title)"],
    ["attorneys", "Attorneys"],
    ["practiceArea", "Practice area"],
    ["website", "Website"],
    ["phone", "Phone"],
    ["publicEmail", "Email"],
    ["address", "Address"],
    ["lastContact", "Last contact"],
    ["nextStep", "Next step"],
    ["nextStepDate", "Next step date"],
  ];
  const inputs = {};
  return h(
    "section",
    {},
    h("h3", {}, "Details"),
    h(
      "div",
      { class: "form-grid" },
      ...fields.map(([k, label]) =>
        h("div", {}, h("label", {}, label), (inputs[k] = h("input", { value: f[k], type: k === "lastContact" || k === "nextStepDate" ? "date" : "text" }))),
      ),
    ),
    h("label", {}, "Notes"),
    (inputs.notes = h("textarea", { value: f.notes })),
    h(
      "div",
      { class: "row" },
      h("button", { class: "btn primary", onclick: () => act(() => api("PATCH", `/api/firms/${f.id}`, Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]))), "Saved") }, "Save details"),
    ),
  );
}

function emailsSection(f, blocked) {
  const kinds = Object.entries(S.draftKinds);
  return h(
    "section",
    {},
    h("h3", {}, "Emails"),
    blocked
      ? h("p", { class: "muted" }, f.status === "Opted out" ? "Opted out: never contact this firm again." : "No emails until this firm is reviewed and accepted.")
      : h(
          "div",
          { class: "row" },
          ...kinds.map(([k, label]) =>
            h("button", { class: "btn", onclick: () => act(() => api("POST", `/api/firms/${f.id}/drafts`, { kind: k }), `${label} drafted`) }, `Draft ${label.toLowerCase()}`),
          ),
        ),
    ...f.drafts
      .slice()
      .reverse()
      .map((d) => draftView(f, d)),
  );
}

function draftView(f, d) {
  const kind = S.draftKinds[d.kind];
  if (d.state === "draft") {
    const subj = h("input", { class: "subject", value: d.subject, "aria-label": "Subject" });
    const body = h("textarea", { class: "mail", value: d.body, "aria-label": "Email body" });
    const placeholders = [...new Set((`${d.subject}\n${d.body}`.match(/\[[^\]\n]{1,80}\]/g) || []))];
    const save = () => api("PATCH", `/api/firms/${f.id}/drafts/${d.id}`, { subject: subj.value, body: body.value });
    return h(
      "div",
      { class: "draft" },
      h("div", { class: "head" }, h("strong", {}, `${kind}: draft`), h("span", { class: "muted" }, fmtDate(d.updatedAt))),
      h("label", {}, "Subject"),
      subj,
      h("label", {}, "Body"),
      body,
      placeholders.length ? h("div", { class: "problems" }, "Replace before approval: ", placeholders.join(", ")) : null,
      h(
        "div",
        { class: "row" },
        h("button", { class: "btn", onclick: () => act(save, "Draft saved") }, "Save"),
        h(
          "button",
          {
            class: "btn primary",
            onclick: async () => {
              try {
                await save();
              } catch (err) {
                return toast(err.message, true);
              }
              const pin = await askPin(`Approve this ${kind.toLowerCase()}?`);
              if (pin === null) return refresh();
              act(() => api("POST", `/api/firms/${f.id}/drafts/${d.id}/approve`, { pin }), "Approved");
            },
          },
          "Save and approve",
        ),
        h(
          "button",
          {
            class: "btn danger",
            onclick: async () => {
              if (await confirmBox("Delete this draft?", "It cannot be brought back.", "Delete")) act(() => api("DELETE", `/api/firms/${f.id}/drafts/${d.id}`), "Draft deleted");
            },
          },
          "Delete",
        ),
      ),
    );
  }
  const to = f.publicEmail;
  const mailto = `mailto:${encodeURIComponent(to || "")}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)}`;
  return h(
    "div",
    { class: "draft" },
    h(
      "div",
      { class: "head" },
      h("strong", {}, `${kind}: ${d.state === "approved" ? `approved by ${d.approvedBy}` : `sent ${fmtDate(d.sentAt)}`}`),
      h("span", { class: "muted" }, d.state === "approved" ? fmtDate(d.approvedAt) : ""),
    ),
    h("div", {}, h("strong", {}, "Subject: "), d.subject),
    h("div", { class: "note", style: "margin-top:6px" }, d.body),
    d.state === "approved"
      ? h(
          "div",
          { class: "row" },
          h("button", { class: "btn", onclick: () => copy(d.subject, "Subject") }, "Copy subject"),
          h("button", { class: "btn", onclick: () => copy(d.body, "Email") }, "Copy email"),
          h("a", { class: "btn", href: mailto }, "Open in email app"),
          h(
            "button",
            {
              class: "btn primary",
              onclick: async () => {
                if (await confirmBox("Did you send it?", "Only mark it sent after you have sent it yourself from Outlook.", "Yes, I sent it")) {
                  act(() => api("POST", `/api/firms/${f.id}/drafts/${d.id}/sent`, {}), "Marked sent");
                }
              },
            },
            "Mark sent",
          ),
          h("button", { class: "btn", onclick: () => act(() => api("POST", `/api/firms/${f.id}/drafts/${d.id}/unapprove`, {}), "Back to draft") }, "Unapprove to edit"),
        )
      : null,
  );
}

function speedCheckSection(f, blocked) {
  const wrap = h("section", {}, h("h3", {}, "Speed check"));
  if (!f.permission) {
    if (blocked) {
      wrap.append(h("p", { class: "muted" }, "Not available for this firm."));
      return wrap;
    }
    const who = h("input", { placeholder: "Name and title" });
    const date = h("input", { type: "date" });
    const how = h("input", { placeholder: "For example: replied yes to our email" });
    wrap.append(
      h("p", { class: "muted" }, "Never send a test inquiry until the firm has agreed. Write down who agreed first."),
      h("div", { class: "form-grid" }, h("div", {}, h("label", {}, "Who agreed"), who), h("div", {}, h("label", {}, "Date"), date), h("div", {}, h("label", {}, "How"), how)),
      h("div", { class: "row" }, h("button", { class: "btn primary", onclick: () => act(() => api("POST", `/api/firms/${f.id}/permission`, { grantedBy: who.value, date: date.value, how: how.value }), "Permission recorded") }, "Record permission")),
    );
    return wrap;
  }
  const sc = f.speedCheck;
  const locked = sc.reportState !== "draft";
  const p = f.permission;
  wrap.append(h("div", { class: "ok-box" }, `Permission: ${p.grantedBy}, ${p.date}, ${p.how}`));
  const inputs = {};
  const dt = (k, label) => h("div", {}, h("label", {}, label), (inputs[k] = h("input", { type: "datetime-local", value: sc[k], disabled: locked })));
  const yn = (k, label) =>
    h("div", {}, h("label", {}, label), (inputs[k] = h("select", { disabled: locked }, ...["", "Yes", "No"].map((v) => h("option", { value: v, selected: sc[k] === v }, v || "Choose")))));
  wrap.append(
    h(
      "div",
      { class: "form-grid" },
      h("div", {}, h("label", {}, "Sent through"), (inputs.channel = h("input", { value: sc.channel, placeholder: "website form, phone or email", disabled: locked }))),
      h("div", {}, h("label", {}, "Posing as someone needing"), (inputs.need = h("input", { value: sc.need, disabled: locked }))),
      dt("inquirySentAt", "Inquiry sent at"),
      dt("firstReplyAt", "First reply at"),
      dt("consultBookedAt", "Consult booked at"),
      dt("checkedAt", "Checked at (if no reply or booking yet)"),
      yn("afterHours", "Reply after hours or on weekends?"),
      yn("followUp", "Followed up when no answer?"),
    ),
    h("label", {}, "What the client experienced (2 or 3 plain sentences, facts only, no blame)"),
    (inputs.experience = h("textarea", { value: sc.experience, disabled: locked })),
    h("label", {}, "What instant intake would look like for them"),
    (inputs.instantIntake = h("textarea", { value: sc.instantIntake, disabled: locked })),
  );
  const problems = S.reportProblems[f.id] || [];
  if (!locked && problems.length) wrap.append(h("ul", { class: "problems" }, ...problems.map((x) => h("li", {}, x))));
  const save = () => api("PATCH", `/api/firms/${f.id}/speedcheck`, Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value])));
  const preview = h("a", { class: "btn", href: `/report/${f.id}?t=${encodeURIComponent(TOKEN)}`, target: "_blank", rel: "noopener" }, "Open report");
  if (!locked) {
    wrap.append(
      h(
        "div",
        { class: "row" },
        h("button", { class: "btn", onclick: () => act(save, "Speed check saved") }, "Save"),
        preview,
        h(
          "button",
          {
            class: "btn primary",
            onclick: async () => {
              try {
                await save();
              } catch (err) {
                return toast(err.message, true);
              }
              const pin = await askPin("Approve this report?");
              if (pin === null) return refresh();
              act(() => api("POST", `/api/firms/${f.id}/speedcheck/approve`, { pin }), "Report approved");
            },
          },
          "Save and approve report",
        ),
      ),
    );
  } else if (sc.reportState === "approved") {
    wrap.append(
      h("div", { class: "ok-box" }, `Report approved by ${sc.approvedBy}. Open it, print to PDF, and attach it to the cover note.`),
      h(
        "div",
        { class: "row" },
        preview,
        h(
          "button",
          {
            class: "btn primary",
            onclick: async () => {
              if (await confirmBox("Did you send the report?", "Only mark it sent after you have emailed it yourself.", "Yes, I sent it")) act(() => api("POST", `/api/firms/${f.id}/speedcheck/sent`, {}), "Report marked sent");
            },
          },
          "Mark report sent",
        ),
        h("button", { class: "btn", onclick: () => act(() => api("POST", `/api/firms/${f.id}/speedcheck/unapprove`, {}), "Report back to draft") }, "Unapprove to edit"),
      ),
    );
  } else {
    wrap.append(h("div", { class: "ok-box" }, `Report sent ${fmtDate(sc.sentAt)}.`), h("div", { class: "row" }, preview));
  }
  return wrap;
}

function timelineSection(f) {
  const labels = {
    found: "Found by search",
    added: "Added to tracker",
    reviewed: "Accepted in review",
    rejected: "Rejected",
    status: "Status changed",
    draft_approved: "Email approved",
    emailed: "Email sent",
    replied: "Reply logged",
    permission: "Speed check permission recorded",
    report_approved: "Report approved",
    report_sent: "Report sent",
    call_booked: "Call booked",
    proposal_sent: "Proposal sent",
    signed: "Signed",
    opted_out: "Opted out",
  };
  const items = S.events.filter((e) => e.firmId === f.id).slice().reverse();
  return h(
    "section",
    {},
    h("h3", {}, "History"),
    items.length
      ? h("ul", { class: "list" }, ...items.map((e) => h("li", {}, h("span", { class: "muted" }, fmtDate(e.at), " "), labels[e.type] || e.type, e.detail ? `: ${e.type === "emailed" ? S.draftKinds[e.detail] || e.detail : e.detail}` : "")))
      : h("p", { class: "muted" }, "Nothing yet."),
  );
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openFirmId && !document.getElementById("dlg").open) closePanel();
});

refresh()
  .then(() => {
    if (S.job && S.job.state === "running") startPolling();
  })
  .catch((err) => {
    document.getElementById("main").replaceChildren(h("div", { class: "problems" }, `Could not load the app: ${err.message}. Reload the page.`));
  });
