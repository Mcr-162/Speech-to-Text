"use strict";

/* =========================================================================
   Sprachnotizen – App-Logik
   - Diktat (über die iOS-Tastatur-Diktierfunktion in einem <textarea>)
   - Heuristische Zerlegung/Klassifizierung in Notiz / To-do / Termin
   - Lokale Speicherung (localStorage) => funktioniert komplett offline
   - Synchronisation mit Google Calendar & Google Tasks via OAuth (GIS)
   - Notizen werden per mailto: an ausgewählte Empfänger verschickt
   ========================================================================= */

const SCOPES = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/tasks";
const STORAGE_KEY = "sprachnotizen_state_v1";

const WEEKDAYS = ["sonntag", "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag"];
const WEEKDAY_LABELS_SHORT = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const MONTH_LABELS_SHORT = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) throw new Error("empty");
    const parsed = JSON.parse(raw);
    return Object.assign(
      { clientId: "", recipients: [], notes: [], todos: [], events: [] },
      parsed
    );
  } catch (e) {
    return { clientId: "", recipients: [], notes: [], todos: [], events: [] };
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error("Speichern fehlgeschlagen", e);
  }
}

const state = loadState();

let accessToken = null;
let tokenExpiry = 0;
let tokenClient = null;
let reviewItems = [];

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function todayISO(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatDateHuman(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${WEEKDAY_LABELS_SHORT[dt.getDay()]}, ${d}. ${MONTH_LABELS_SHORT[m - 1]}`;
}

function formatCreatedAt(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (sameDay) return `Heute, ${time}`;
  return `${formatDateHuman(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`)}, ${time}`;
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function showToast(msg, ms = 2800) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("show"), ms);
}

// ---------------------------------------------------------------------
// Parsing & Klassifizierung
// ---------------------------------------------------------------------

function splitIntoSegments(text) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function nextWeekday(targetDow) {
  const d = new Date();
  const currentDow = d.getDay();
  let diff = (targetDow - currentDow + 7) % 7;
  if (diff === 0) diff = 7; // "montag" gesprochen am Montag meint i.d.R. den nächsten Montag
  d.setDate(d.getDate() + diff);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function extractDateTime(text) {
  const lower = text.toLowerCase();
  let date = null;
  let time = null;

  // explizites Datum: 12.10. oder 12.10.2026
  const dateMatch = lower.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})?\b/);
  if (dateMatch) {
    const day = parseInt(dateMatch[1], 10);
    const month = parseInt(dateMatch[2], 10);
    let year = dateMatch[3] ? parseInt(dateMatch[3], 10) : new Date().getFullYear();
    if (year < 100) year += 2000;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      date = `${year}-${pad2(month)}-${pad2(day)}`;
    }
  }

  if (!date) {
    if (/\bübermorgen\b/.test(lower)) {
      date = todayISO(2);
    } else if (/(?<!guten\s)\bmorgen\b/.test(lower)) {
      date = todayISO(1);
    } else if (/\bheute\b/.test(lower)) {
      date = todayISO(0);
    } else {
      for (let i = 0; i < WEEKDAYS.length; i++) {
        const wd = WEEKDAYS[i];
        if (new RegExp(`\\b${wd}\\b`).test(lower) || (wd === "samstag" && /\bsonnabend\b/.test(lower))) {
          date = nextWeekday(i);
          break;
        }
      }
    }
  }

  // Uhrzeit: "15 uhr", "15:30 uhr", "um 9 uhr"
  const timeMatch = lower.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s?uhr\b/);
  if (timeMatch) {
    const h = parseInt(timeMatch[1], 10);
    const m = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      time = `${pad2(h)}:${pad2(m)}`;
    }
  }

  return { date, time };
}

const EVENT_HINT = /\b(termin|meeting|treffen|verabredung|besprechung|sprechstunde|unterricht(sbesuch)?|prüfung|klausur(termin)?)\b/;
const TODO_HINT = /\b(todo|to-do|aufgabe|erinnere\s?mich|nicht\s?vergessen|muss\s?ich|kaufen|besorgen|anrufen|erledigen|einkaufen|abgeben|vorbereiten|fertig\s?machen|einreichen|bestellen)\b/;

function classifySegment(text) {
  const lower = text.toLowerCase();
  const dt = extractDateTime(text);
  if (dt.date || EVENT_HINT.test(lower)) {
    return { type: "event", date: dt.date || todayISO(0), time: dt.time };
  }
  if (TODO_HINT.test(lower)) {
    return { type: "todo", date: dt.date, time: null };
  }
  return { type: "note", date: null, time: null };
}

// ---------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------

function setActiveTab(tab) {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  document.querySelectorAll(".view").forEach((view) => {
    if (view.id === "view-settings") return;
    view.classList.toggle("active", view.id === `view-${tab}`);
  });
  if (tab === "notes") renderNotes();
  if (tab === "todos") renderTodos();
  if (tab === "events") renderEvents();
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
});

// ---------------------------------------------------------------------
// Aufnahme / Review
// ---------------------------------------------------------------------

const dictateField = document.getElementById("dictateField");
const reviewCard = document.getElementById("reviewCard");
const reviewList = document.getElementById("reviewList");

document.getElementById("processBtn").addEventListener("click", () => {
  const text = dictateField.value.trim();
  if (!text) {
    showToast("Bitte zuerst etwas diktieren oder eintippen.");
    return;
  }
  const segments = splitIntoSegments(text);
  reviewItems = segments.map((seg) => {
    const cls = classifySegment(seg);
    return { id: genId(), text: seg, ...cls };
  });
  renderReview();
  reviewCard.classList.remove("hidden");
  reviewCard.scrollIntoView({ behavior: "smooth", block: "start" });
});

function typeMeta(type) {
  return {
    note: { label: "Notiz", cls: "note" },
    todo: { label: "To-do", cls: "todo" },
    event: { label: "Termin", cls: "event" },
  }[type];
}

function renderReview() {
  reviewList.innerHTML = "";
  reviewItems.forEach((item) => {
    const wrap = document.createElement("div");
    wrap.className = "review-item";
    wrap.dataset.id = item.id;

    const chipRow = document.createElement("div");
    chipRow.className = "type-chip-row";
    ["note", "todo", "event"].forEach((t) => {
      const meta = typeMeta(t);
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "type-chip" + (item.type === t ? ` selected ${meta.cls}` : "");
      chip.innerHTML = `<span class="dot ${meta.cls}"></span>${meta.label}`;
      chip.addEventListener("click", () => {
        item.type = t;
        if (t === "event" && !item.date) item.date = todayISO(0);
        renderReview();
      });
      chipRow.appendChild(chip);
    });
    wrap.appendChild(chipRow);

    const textarea = document.createElement("textarea");
    textarea.value = item.text;
    textarea.addEventListener("input", (e) => { item.text = e.target.value; });
    wrap.appendChild(textarea);

    if (item.type === "event") {
      const fields = document.createElement("div");
      fields.className = "event-fields";
      const dateInput = document.createElement("input");
      dateInput.type = "date";
      dateInput.value = item.date || todayISO(0);
      dateInput.addEventListener("change", (e) => { item.date = e.target.value; });
      const timeInput = document.createElement("input");
      timeInput.type = "time";
      timeInput.value = item.time || "";
      timeInput.addEventListener("change", (e) => { item.time = e.target.value || null; });
      fields.appendChild(dateInput);
      fields.appendChild(timeInput);
      wrap.appendChild(fields);
    }

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-item";
    removeBtn.textContent = "Eintrag entfernen";
    removeBtn.addEventListener("click", () => {
      reviewItems = reviewItems.filter((i) => i.id !== item.id);
      renderReview();
      if (reviewItems.length === 0) reviewCard.classList.add("hidden");
    });
    wrap.appendChild(removeBtn);

    reviewList.appendChild(wrap);
  });
}

document.getElementById("discardBtn").addEventListener("click", () => {
  reviewItems = [];
  reviewCard.classList.add("hidden");
});

document.getElementById("confirmAllBtn").addEventListener("click", () => {
  if (reviewItems.length === 0) return;
  let counts = { note: 0, todo: 0, event: 0 };
  reviewItems.forEach((item) => {
    const now = Date.now();
    if (item.type === "note") {
      state.notes.unshift({ id: item.id, text: item.text, createdAt: now });
    } else if (item.type === "todo") {
      state.todos.unshift({
        id: item.id, text: item.text, done: false, createdAt: now,
        date: item.date || null, googleId: null, syncStatus: "pending",
      });
    } else if (item.type === "event") {
      state.events.unshift({
        id: item.id, text: item.text, createdAt: now,
        date: item.date || todayISO(0), time: item.time || null,
        googleId: null, syncStatus: "pending",
      });
    }
    counts[item.type]++;
  });
  saveState();
  const parts = [];
  if (counts.note) parts.push(`${counts.note} Notiz${counts.note > 1 ? "en" : ""}`);
  if (counts.todo) parts.push(`${counts.todo} To-do${counts.todo > 1 ? "s" : ""}`);
  if (counts.event) parts.push(`${counts.event} Termin${counts.event > 1 ? "e" : ""}`);
  showToast(`Gespeichert: ${parts.join(", ")}`);

  reviewItems = [];
  reviewCard.classList.add("hidden");
  dictateField.value = "";

  trySync();
});

// ---------------------------------------------------------------------
// Listen: Notizen / To-dos / Termine
// ---------------------------------------------------------------------

function emptyState(icon, text) {
  return `<div class="empty-state">${icon}<p>${text}</p></div>`;
}

const ICON_NOTE = `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>`;
const ICON_TODO = `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`;
const ICON_EVENT = `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;

function renderNotes() {
  const el = document.getElementById("notesList");
  if (state.notes.length === 0) {
    el.innerHTML = emptyState(ICON_NOTE, "Noch keine Notizen. Diktiere dein erstes Memo unter „Aufnehmen“.");
    return;
  }
  el.innerHTML = state.notes.map((n) => `
    <div class="list-item note" data-id="${n.id}">
      <span class="marker"></span>
      <div class="body">
        <div class="text">${escapeHtml(n.text)}</div>
        <div class="meta">${formatCreatedAt(n.createdAt)}</div>
        <div style="display:flex; gap:14px; margin-top:8px;">
          <button class="btn-ghost" style="padding-left:0;" data-action="send">Per E-Mail senden</button>
          <button class="btn-ghost" data-action="delete">Löschen</button>
        </div>
      </div>
    </div>
  `).join("");

  el.querySelectorAll(".list-item").forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('[data-action="send"]').addEventListener("click", () => sendNoteByEmail(id));
    row.querySelector('[data-action="delete"]').addEventListener("click", () => {
      state.notes = state.notes.filter((n) => n.id !== id);
      saveState();
      renderNotes();
    });
  });
}

function sendNoteByEmail(id) {
  const note = state.notes.find((n) => n.id === id);
  if (!note) return;
  const to = state.recipients.join(",");
  const subject = "Notiz aus Sprachnotizen";
  const body = note.text;
  const mailto = `mailto:${encodeURIComponent(to).replace(/%2C/g, ",")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.location.href = mailto;
  if (state.recipients.length === 0) {
    showToast("Kein Standard-Empfänger hinterlegt – wähle ihn in der Mail-App aus oder trage einen in den Einstellungen ein.");
  }
}

function renderTodos() {
  const el = document.getElementById("todosList");
  if (state.todos.length === 0) {
    el.innerHTML = emptyState(ICON_TODO, "Noch keine To-dos. Sag z. B. „Erinnere mich, Milch zu kaufen.“");
    return;
  }
  el.innerHTML = state.todos.map((t) => `
    <div class="list-item todo" data-id="${t.id}">
      <button class="checkbox ${t.done ? "checked" : ""}" data-action="toggle" aria-label="Erledigt">
        ${t.done ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' : ""}
      </button>
      <div class="body">
        <div class="text ${t.done ? "done" : ""}">${escapeHtml(t.text)}</div>
        <div class="meta">${formatCreatedAt(t.createdAt)}${t.date ? " · fällig " + formatDateHuman(t.date) : ""}
          <span class="sync-pill ${t.syncStatus === "synced" ? "synced" : "pending"}">${t.syncStatus === "synced" ? "In Google Tasks" : "Noch nicht synchronisiert"}</span>
        </div>
        <div style="margin-top:8px;">
          <button class="btn-ghost" style="padding-left:0;" data-action="delete">Löschen</button>
        </div>
      </div>
    </div>
  `).join("");

  el.querySelectorAll(".list-item").forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('[data-action="toggle"]').addEventListener("click", () => toggleTodo(id));
    row.querySelector('[data-action="delete"]').addEventListener("click", () => {
      state.todos = state.todos.filter((t) => t.id !== id);
      saveState();
      renderTodos();
    });
  });
}

async function toggleTodo(id) {
  const todo = state.todos.find((t) => t.id === id);
  if (!todo) return;
  todo.done = !todo.done;
  saveState();
  renderTodos();

  if (todo.googleId) {
    const token = await getValidToken();
    if (token) {
      try {
        await fetch(`https://www.googleapis.com/tasks/v1/lists/@default/tasks/${todo.googleId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ status: todo.done ? "completed" : "needsAction" }),
        });
      } catch (e) { /* offline oder Fehler: lokal bleibt der Stand erhalten */ }
    }
  }
}

function renderEvents() {
  const el = document.getElementById("eventsList");
  if (state.events.length === 0) {
    el.innerHTML = emptyState(ICON_EVENT, "Noch keine Termine. Sag z. B. „Morgen um 15 Uhr Zahnarzttermin.“");
    return;
  }
  const sorted = [...state.events].sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
  el.innerHTML = sorted.map((ev) => `
    <div class="list-item event" data-id="${ev.id}">
      <span class="marker"></span>
      <div class="body">
        <div class="text">${escapeHtml(ev.text)}</div>
        <div class="meta">${formatDateHuman(ev.date)}${ev.time ? ", " + ev.time + " Uhr" : " · ganztägig"}
          <span class="sync-pill ${ev.syncStatus === "synced" ? "synced" : "pending"}">${ev.syncStatus === "synced" ? "Im Kalender" : "Noch nicht synchronisiert"}</span>
        </div>
        <div style="margin-top:8px;">
          <button class="btn-ghost" style="padding-left:0;" data-action="delete">Löschen</button>
        </div>
      </div>
    </div>
  `).join("");

  el.querySelectorAll(".list-item").forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('[data-action="delete"]').addEventListener("click", () => {
      state.events = state.events.filter((e) => e.id !== id);
      saveState();
      renderEvents();
    });
  });
}

// ---------------------------------------------------------------------
// Google-Verbindung (OAuth via Google Identity Services)
// ---------------------------------------------------------------------

function ensureTokenClient() {
  if (!window.google || !google.accounts || !google.accounts.oauth2) return null;
  if (!state.clientId) return null;
  if (!tokenClient) {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: state.clientId,
      scope: SCOPES,
      callback: () => {}, // wird pro Aufruf überschrieben
    });
  }
  return tokenClient;
}

function requestToken(interactive) {
  return new Promise((resolve) => {
    const client = ensureTokenClient();
    if (!client) { resolve(null); return; }
    client.callback = (resp) => {
      if (resp && resp.access_token) {
        accessToken = resp.access_token;
        tokenExpiry = Date.now() + (resp.expires_in || 3500) * 1000;
        updateGoogleStatusUI(true);
        resolve(accessToken);
      } else {
        resolve(null);
      }
    };
    try {
      client.requestAccessToken({ prompt: interactive ? "consent" : "" });
    } catch (e) {
      resolve(null);
    }
  });
}

async function getValidToken() {
  if (accessToken && Date.now() < tokenExpiry - 30000) return accessToken;
  if (!navigator.onLine) return null;
  return requestToken(false);
}

function updateGoogleStatusUI(connected) {
  const dot = document.getElementById("googleStatusDot");
  const text = document.getElementById("googleStatusText");
  const connectBtn = document.getElementById("connectGoogleBtn");
  const disconnectBtn = document.getElementById("disconnectGoogleBtn");
  if (connected) {
    dot.className = "status-dot online";
    text.textContent = "Verbunden – Termine & To-dos werden synchronisiert";
    connectBtn.textContent = "Erneut verbinden";
    disconnectBtn.classList.remove("hidden");
  } else {
    dot.className = "status-dot offline";
    text.textContent = state.clientId ? "Nicht verbunden" : "Erst Client-ID eintragen";
    connectBtn.textContent = "Mit Google verbinden";
    disconnectBtn.classList.add("hidden");
  }
}

document.getElementById("connectGoogleBtn").addEventListener("click", async () => {
  if (!state.clientId) {
    showToast("Bitte zuerst eine Client-ID eintragen und speichern.");
    return;
  }
  if (!navigator.onLine) {
    showToast("Für die Google-Verbindung wird kurz Internet benötigt.");
    return;
  }
  const token = await requestToken(true);
  if (token) {
    showToast("Mit Google verbunden.");
    trySync();
  } else {
    showToast("Verbindung nicht zustande gekommen.");
  }
});

document.getElementById("disconnectGoogleBtn").addEventListener("click", () => {
  if (accessToken && window.google && google.accounts) {
    try { google.accounts.oauth2.revoke(accessToken, () => {}); } catch (e) {}
  }
  accessToken = null;
  tokenExpiry = 0;
  updateGoogleStatusUI(false);
  showToast("Verbindung getrennt.");
});

document.getElementById("saveClientIdBtn").addEventListener("click", () => {
  const val = document.getElementById("clientIdInput").value.trim();
  state.clientId = val;
  saveState();
  tokenClient = null;
  accessToken = null;
  tokenExpiry = 0;
  updateGoogleStatusUI(false);
  showToast(val ? "Client-ID gespeichert." : "Client-ID entfernt.");
});

// ---------------------------------------------------------------------
// Synchronisation mit Google Calendar / Tasks
// ---------------------------------------------------------------------

let syncing = false;

async function trySync() {
  if (syncing) return;
  if (!navigator.onLine || !state.clientId) return;
  const pendingTodos = state.todos.filter((t) => t.syncStatus === "pending");
  const pendingEvents = state.events.filter((e) => e.syncStatus === "pending");
  if (pendingTodos.length === 0 && pendingEvents.length === 0) return;

  const token = await getValidToken();
  if (!token) return;

  syncing = true;
  let syncedCount = 0;

  for (const todo of pendingTodos) {
    try {
      const body = { title: todo.text };
      if (todo.date) body.due = `${todo.date}T00:00:00.000Z`;
      const res = await fetch("https://www.googleapis.com/tasks/v1/lists/@default/tasks", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        todo.googleId = data.id;
        todo.syncStatus = "synced";
        syncedCount++;
      } else if (res.status === 401) {
        accessToken = null;
        break;
      }
    } catch (e) { /* bleibt pending, nächster Versuch später */ }
  }

  for (const ev of pendingEvents) {
    try {
      const body = { summary: ev.text.slice(0, 120), description: ev.text };
      if (ev.time) {
        const start = `${ev.date}T${ev.time}:00`;
        const endDate = new Date(`${ev.date}T${ev.time}:00`);
        endDate.setHours(endDate.getHours() + 1);
        const end = `${endDate.getFullYear()}-${pad2(endDate.getMonth() + 1)}-${pad2(endDate.getDate())}T${pad2(endDate.getHours())}:${pad2(endDate.getMinutes())}:00`;
        body.start = { dateTime: start, timeZone: "Europe/Berlin" };
        body.end = { dateTime: end, timeZone: "Europe/Berlin" };
      } else {
        const d = new Date(ev.date);
        d.setDate(d.getDate() + 1);
        const nextDay = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
        body.start = { date: ev.date };
        body.end = { date: nextDay };
      }
      const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        ev.googleId = data.id;
        ev.syncStatus = "synced";
        syncedCount++;
      } else if (res.status === 401) {
        accessToken = null;
        break;
      }
    } catch (e) { /* bleibt pending */ }
  }

  syncing = false;
  saveState();
  renderTodos();
  renderEvents();
  if (syncedCount > 0) {
    showToast(`${syncedCount} Eintrag${syncedCount > 1 ? "e" : ""} mit Google synchronisiert.`);
  }
}

// ---------------------------------------------------------------------
// Empfänger-Verwaltung
// ---------------------------------------------------------------------

function renderRecipients() {
  const el = document.getElementById("recipientList");
  el.innerHTML = state.recipients.map((r) => `
    <span class="recipient-tag">${escapeHtml(r)}<button data-r="${escapeHtml(r)}" aria-label="Entfernen">&times;</button></span>
  `).join("");
  el.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.recipients = state.recipients.filter((r) => r !== btn.dataset.r);
      saveState();
      renderRecipients();
    });
  });
}

document.getElementById("addRecipientBtn").addEventListener("click", () => {
  const input = document.getElementById("recipientInput");
  const val = input.value.trim();
  if (!val) return;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
    showToast("Das sieht nicht nach einer gültigen E-Mail-Adresse aus.");
    return;
  }
  if (!state.recipients.includes(val)) {
    state.recipients.push(val);
    saveState();
    renderRecipients();
  }
  input.value = "";
});

// ---------------------------------------------------------------------
// Einstellungen öffnen/schließen
// ---------------------------------------------------------------------

const settingsView = document.getElementById("view-settings");

document.getElementById("openSettings").addEventListener("click", () => {
  document.getElementById("clientIdInput").value = state.clientId || "";
  updateGoogleStatusUI(!!accessToken);
  renderRecipients();
  settingsView.style.display = "block";
});

document.getElementById("closeSettings").addEventListener("click", () => {
  settingsView.style.display = "none";
});

// ---------------------------------------------------------------------
// Netzwerkstatus
// ---------------------------------------------------------------------

function updateNetStatus() {
  const dot = document.getElementById("netStatusDot");
  dot.className = "status-dot " + (navigator.onLine ? "online" : "offline");
  dot.title = navigator.onLine ? "Online" : "Offline – Einträge werden lokal gespeichert";
}

window.addEventListener("online", () => { updateNetStatus(); trySync(); });
window.addEventListener("offline", updateNetStatus);

// ---------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------

function init() {
  updateNetStatus();
  updateGoogleStatusUI(false);
  renderNotes();
  renderTodos();
  renderEvents();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // Versuche nach kurzer Zeit einen stillen Sync (falls Client-ID vorhanden
  // und der Browser die Zustimmung noch aus einer früheren Sitzung kennt).
  setTimeout(() => { if (state.clientId) trySync(); }, 1500);
}

document.addEventListener("DOMContentLoaded", init);
