(() => {
  "use strict";

  const TZ = "America/Vancouver";
  const $ = (sel) => document.querySelector(sel);

  /* ---------- date helpers (calendar math is timezone-agnostic on YYYY-MM-DD strings) ---------- */
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  function todayIso() {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t).value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  }
  function addDays(s, n) {
    const [y, m, d] = s.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  function daysBetween(a, b) {
    const [y1, m1, d1] = a.split("-").map(Number);
    const [y2, m2, d2] = b.split("-").map(Number);
    return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 864e5);
  }
  function longDate(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  }
  function fmt12(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    const ampm = h >= 12 ? "pm" : "am";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${pad(m)} ${ampm}`;
  }

  /* ---------- state ---------- */
  const TODAY = todayIso();
  const params = new URLSearchParams(location.search);
  const state = {
    date: params.get("date") && params.get("date") >= TODAY ? params.get("date") : addDays(TODAY, 1),
    time: params.get("time") || "09:00",
    anyTime: params.get("time") === "",
    window: Number(params.get("window") || 90),
    players: Number(params.get("players") || 2),
    holes: Number(params.get("holes") || 18),
    courses: null, // null = all
    view: null, // "YYYY-MM" currently displayed month
  };
  state.view = state.date.slice(0, 7);
  let courseCatalog = [];

  /* ---------- calendar ---------- */
  function renderCalendar() {
    const [y, m] = state.view.split("-").map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    $("#calTitle").textContent = first.toLocaleDateString("en-CA", { month: "long", year: "numeric", timeZone: "UTC" });
    const grid = $("#calDays");
    grid.innerHTML = "";
    const startOffset = first.getUTCDay();
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const prevDays = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
    const selectedCourses = selectedCourseList();
    const windows = selectedCourses.map((c) => c.bookingWindowDays).filter((w) => w !== null && w !== undefined);
    const minWindow = windows.length ? Math.min(...windows) : null;

    for (let i = 0; i < 42; i++) {
      const dayNum = i - startOffset + 1;
      let cy = y, cm = m, cd = dayNum, other = false;
      if (dayNum < 1) { other = true; cm = m - 1; cd = prevDays + dayNum; if (cm < 1) { cm = 12; cy--; } }
      else if (dayNum > daysInMonth) { other = true; cm = m + 1; cd = dayNum - daysInMonth; if (cm > 12) { cm = 1; cy++; } }
      const d = iso(cy, cm, cd);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "day";
      btn.textContent = String(cd);
      btn.dataset.date = d;
      const past = d < TODAY;
      if (other) btn.classList.add("other");
      if (past) { btn.classList.add("past"); btn.disabled = true; }
      if (d === TODAY) btn.classList.add("today");
      if (d === state.date) btn.classList.add("selected");
      if (!past && minWindow !== null && daysBetween(TODAY, d) <= minWindow) btn.classList.add("open");
      btn.title = past ? "" : minWindow !== null && daysBetween(TODAY, d) <= minWindow ? "Within every selected course's public booking window" : "";
      btn.addEventListener("click", () => {
        state.date = d;
        state.view = d.slice(0, 7);
        renderCalendar();
        updateHint();
      });
      grid.appendChild(btn);
    }
  }
  function shiftMonth(delta) {
    const [y, m] = state.view.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1 + delta, 1));
    state.view = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}`;
    renderCalendar();
  }
  $("#prevMonth").addEventListener("click", () => shiftMonth(-1));
  $("#nextMonth").addEventListener("click", () => shiftMonth(1));

  /* ---------- controls ---------- */
  function wireSeg(id, key) {
    const seg = document.getElementById(id);
    for (const b of seg.querySelectorAll("button")) {
      b.classList.toggle("on", Number(b.dataset.v) === state[key]);
      b.addEventListener("click", () => {
        state[key] = Number(b.dataset.v);
        for (const o of seg.querySelectorAll("button")) o.classList.toggle("on", o === b);
        updateHint();
      });
    }
  }
  wireSeg("window", "window");
  wireSeg("players", "players");
  wireSeg("holes", "holes");

  const timeInput = $("#time");
  const anyTime = $("#anyTime");
  timeInput.value = state.time;
  anyTime.checked = state.anyTime;
  timeInput.disabled = state.anyTime;
  timeInput.addEventListener("change", () => { state.time = timeInput.value || "09:00"; updateHint(); });
  anyTime.addEventListener("change", () => { state.anyTime = anyTime.checked; timeInput.disabled = anyTime.checked; updateHint(); });

  function selectedCourseList() {
    return courseCatalog.filter((c) => !state.courses || state.courses.includes(c.id));
  }
  function renderCourseList() {
    const box = $("#courseList");
    box.innerHTML = "";
    for (const c of courseCatalog) {
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !state.courses || state.courses.includes(c.id);
      cb.addEventListener("change", () => {
        const on = [...box.querySelectorAll("input:checked")].map((i) => i.dataset.id);
        state.courses = on.length === courseCatalog.length ? null : on;
        renderCalendar();
        updateHint();
      });
      cb.dataset.id = c.id;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(c.name));
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = c.live ? (c.bookingWindowDays ? `${c.bookingWindowDays}-day window` : "live") : "link only";
      label.appendChild(tag);
      box.appendChild(label);
    }
  }

  function updateHint() {
    const n = selectedCourseList().length;
    const when = state.anyTime ? "any time" : `around ${fmt12(state.time)} (±${state.window} min)`;
    $("#hint").textContent = `${longDate(state.date)}, ${when}, ${state.players} golfer${state.players > 1 ? "s" : ""}, ${state.holes} holes, ${n} course${n !== 1 ? "s" : ""}.`;
  }

  /* ---------- results ---------- */
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function renderCard(c, req) {
    const card = el("div", "card");
    const head = el("div", "card-head");
    head.appendChild(el("h2", null, c.course.name));
    head.appendChild(el("span", "city", c.course.city));

    if (c.status === "ok" && c.times.length) head.appendChild(el("span", "badge", `${c.times.length} time${c.times.length > 1 ? "s" : ""} fit`));
    else if (c.status === "ok") head.appendChild(el("span", "badge muted", c.totalThatDay ? "nothing in window" : "nothing that day"));
    else if (c.status === "manual") head.appendChild(el("span", "badge warn", "check on site"));
    else head.appendChild(el("span", "badge err", "couldn't fetch"));
    if (c.beyondWindow) head.appendChild(el("span", "badge warn", `public booking opens ${c.bookingOpens}`));

    const book = el("a", "book", "Booking site ↗");
    book.href = c.course.bookingUrl;
    book.target = "_blank";
    book.rel = "noopener";
    head.appendChild(book);
    card.appendChild(head);

    if (c.status === "manual") {
      const why = (c.message || "No public availability feed.").replace(/([^.!?])$/, "$1.");
      card.appendChild(el("p", "msg", `${why} Open the booking site to see times for ${longDate(req.date)}.`));
    } else if (c.status === "error") {
      card.appendChild(el("p", "msg err", c.message || "Request failed."));
    } else if (!c.times.length) {
      card.appendChild(el("p", "msg", c.totalThatDay
        ? `${c.totalThatDay} bookable time${c.totalThatDay > 1 ? "s" : ""} that day, but none ${req.time ? `between ${fmt12(req.from)} and ${fmt12(req.to)}` : ""} with room for ${req.players}.`
        : `No online availability for ${req.players} golfer${req.players > 1 ? "s" : ""} on ${longDate(req.date)}.`));
    } else {
      const times = el("div", "times");
      const LIMIT = 8;
      const sorted = [...c.times].sort((a, b) => a.time.localeCompare(b.time));
      const bestTime = c.times[0].time; // service sorts nearest-first
      const render = (list) => {
        times.innerHTML = "";
        for (const t of list) {
          const a = el("a", "slot" + (t.time === bestTime && req.time ? " best" : ""));
          a.href = t.bookingUrl || c.course.bookingUrl;
          a.target = "_blank";
          a.rel = "noopener";
          a.appendChild(el("span", "t", fmt12(t.time)));
          const meta = [];
          if (t.openSpots !== null) meta.push(`${t.openSpots} open`);
          if (t.price !== null) meta.push(`$${t.price.toFixed(0)}/p`);
          if (t.holes && t.holes !== req.holes) meta.push(`${t.holes} holes`);
          a.appendChild(el("span", "meta", meta.join(" · ") || "spots not reported"));
          if (t.courseName) a.appendChild(el("span", "sub", t.courseName));
          times.appendChild(a);
        }
      };
      render(sorted.slice(0, LIMIT));
      card.appendChild(times);
      if (sorted.length > LIMIT) {
        const more = el("div", "more");
        const btn = el("button", null, `Show ${sorted.length - LIMIT} more`);
        btn.addEventListener("click", () => { render(sorted); more.remove(); });
        more.appendChild(btn);
        card.appendChild(more);
      }
    }
    if (c.course.notes) card.appendChild(el("p", "msg", c.course.notes));
    return card;
  }

  async function check() {
    const go = $("#go");
    const results = $("#results");
    go.disabled = true;
    results.innerHTML = "";
    const n = selectedCourseList().length;
    for (let i = 0; i < n; i++) results.appendChild(el("div", "skeleton"));

    const q = new URLSearchParams({ date: state.date, players: String(state.players), window: String(state.window), holes: String(state.holes) });
    q.set("time", state.anyTime ? "" : state.time);
    if (state.courses) q.set("courses", state.courses.join(","));
    history.replaceState(null, "", `?${q.toString()}`);

    try {
      const res = await fetch(`/api/availability?${q.toString()}`);
      const data = await res.json();
      results.innerHTML = "";
      if (!res.ok) {
        results.appendChild(el("div", "empty", data.error || `Request failed (${res.status})`));
        return;
      }
      const req = data.request;
      const fitting = data.courses.reduce((s, c) => s + c.times.length, 0);
      const live = data.courses.filter((c) => c.status === "ok").length;
      results.appendChild(el("div", "summary",
        `${longDate(req.date)}${req.time ? `, ${fmt12(req.from)} to ${fmt12(req.to)}` : ", any time"}, ${req.players} golfer${req.players > 1 ? "s" : ""}: ` +
        `${fitting} tee time${fitting !== 1 ? "s" : ""} across ${live} course${live !== 1 ? "s" : ""} checked live.`));
      const order = [...data.courses].sort((a, b) => {
        const rank = (c) => (c.status === "ok" && c.times.length ? 0 : c.status === "ok" ? 1 : c.status === "manual" ? 2 : 3);
        return rank(a) - rank(b) || b.times.length - a.times.length;
      });
      for (const c of order) results.appendChild(renderCard(c, req));
    } catch (err) {
      results.innerHTML = "";
      results.appendChild(el("div", "empty", `Could not reach the server: ${err.message}`));
    } finally {
      go.disabled = false;
    }
  }
  $("#go").addEventListener("click", check);

  /* ---------- boot ---------- */
  (async () => {
    try {
      const res = await fetch("/api/courses");
      const data = await res.json();
      courseCatalog = data.courses;
      const fromUrl = params.get("courses");
      if (fromUrl) state.courses = fromUrl.split(",").filter((id) => courseCatalog.some((c) => c.id === id));
      if (state.courses && state.courses.length === courseCatalog.length) state.courses = null;
    } catch {
      courseCatalog = [];
    }
    renderCourseList();
    renderCalendar();
    updateHint();
    if (params.has("date")) check();
  })();
})();
