(() => {
  "use strict";

  const cfg = window.PYRAMIDE_CONFIG;
  const dict = window.PYRAMIDE_I18N;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const LIVE_DB = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  const ORDER_RE = /^PYR-[A-HJ-NP-Z2-9]{6}$/;
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  /* ── storage (never throws) ─────────────────── */
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem("pyr_" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("pyr_" + k, JSON.stringify(v)); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem("pyr_" + k); } catch { /* ignore */ } }
  };

  /* ── state ─────────────────────────────────── */
  const state = {
    lang: initialLang(),
    order: store.get("current"),           // { no, demo }
    days: [],
    dayIndex: 0,
    taken: new Set(),
    loadingTaken: false,
    slot: null,                             // ms timestamp
    qty: 1,
    existing: null                          // ms timestamp of an earlier booking
  };

  function initialLang() {
    const saved = store.get("lang");
    if (saved === "de" || saved === "en") return saved;
    const nav = (navigator.languages && navigator.languages[0]) || navigator.language || "de";
    return /^de\b/i.test(nav) ? "de" : "en";
  }

  const t = (key, vars) => {
    let s = (dict[state.lang] && dict[state.lang][key]) ?? dict.de[key] ?? key;
    vars = Object.assign({ price: money(cfg.priceEur) }, vars);
    for (const [k, v] of Object.entries(vars)) s = s.split("{" + k + "}").join(v);
    return s;
  };
  const locale = () => (state.lang === "de" ? "de-DE" : "en-GB");
  const money = (n) => new Intl.NumberFormat(locale(), { style: "currency", currency: "EUR", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n);
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ── i18n ──────────────────────────────────── */
  function applyLang() {
    document.documentElement.lang = state.lang;
    $$("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
    $$("[data-i18n-html]").forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
    $$("[data-i18n-placeholder]").forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    $$("[data-i18n-alt]").forEach((el) => { el.alt = t(el.dataset.i18nAlt); });
    $$("[data-i18n-aria]").forEach((el) => { el.setAttribute("aria-label", t(el.dataset.i18nAria)); });
    document.title = t("meta.title");
    const md = $('meta[name="description"]'); if (md) md.content = t("meta.desc");
    $$(".lang-btn").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === state.lang)));

    $$("[data-price]").forEach((el) => { el.textContent = money(cfg.priceEur); });

    if (currentView === "shop") renderReturn();
    if (currentView === "book") renderBooking();
    if (currentView === "done") renderDone();
    if (currentView === "order") renderOrder();
  }

  /* ── static bits ───────────────────────────── */
  const mapsUrl = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(cfg.mapsQuery);
  $$("[data-maps]").forEach((a) => { a.href = mapsUrl; });
  $$("[data-address]").forEach((el) => { el.textContent = cfg.placeAddress; });
  $("#year").textContent = new Date().getFullYear();
  $("#previewBanner").hidden = LIVE_DB;

  /* ── toast ─────────────────────────────────── */
  let toastTimer;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
  }

  /* ── order numbers ─────────────────────────── */
  function newOrderNo() {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return "PYR-" + Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
  }
  function normalizeOrder(raw) {
    let s = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (s.startsWith("PYR")) s = s.slice(3);
    return "PYR-" + s;
  }
  function setOrder(no) {
    state.order = { no };
    store.set("current", state.order);
  }

  /* ── views & routing ───────────────────────── */
  let currentView = null;
  function routeFromHash() {
    const h = location.hash;
    if (h === "#/order") return state.order ? "order" : "shop";
    if (h === "#/book") return "book";
    if (h === "#/done") return store.get("booking:" + (state.order && state.order.no)) ? "done" : "shop";
    return "shop";
  }
  function go(view) {
    if (view === "shop") {
      if (location.hash) history.pushState(null, "", location.pathname + location.search);
      render("shop");
    } else if (location.hash !== "#/" + view) {
      location.hash = "#/" + view; // triggers hashchange → render
    } else {
      render(view);
    }
  }
  function render(view) {
    if (view === "book" && !(state.order && ORDER_RE.test(state.order.no))) {
      openLookup();
      view = "shop";
      if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    }
    const changed = view !== currentView;
    currentView = view;
    $$(".view").forEach((v) => {
      const on = v.dataset.view === view;
      v.hidden = !on;
      if (on && changed) { v.classList.remove("view-enter"); void v.offsetWidth; v.classList.add("view-enter"); }
    });
    if (changed && !(view === "shop" && /^#[a-z]/.test(location.hash))) window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
    if (changed) ping();
    if (view === "shop") renderReturn();
    if (view === "order") renderOrder();
    if (view === "book") enterBooking();
    if (view === "done") renderDone();
  }
  // returning visitor: show their upcoming reservation on the home page
  function renderReturn() {
    const card = $("#returnCard"); if (!card) return;
    const b = state.order && store.get("booking:" + state.order.no);
    const show = !!(b && b.slot + cfg.slotMinutes * 60000 > Date.now());
    card.hidden = !show;
    if (show) {
      $("#returnWhen").textContent = fmtWhen(b.slot);
      $("#returnOrder").textContent = state.order.no;
    }
  }

  window.addEventListener("hashchange", () => render(routeFromHash()));
  window.addEventListener("popstate", () => render(routeFromHash()));

  $$("[data-go]").forEach((el) => el.addEventListener("click", (e) => { e.preventDefault(); go(el.dataset.go); }));
  $$("[data-scroll]").forEach((a) => a.addEventListener("click", (e) => {
    const target = $(a.getAttribute("href"));
    if (!target) return;
    e.preventDefault();
    if (currentView !== "shop") go("shop");
    requestAnimationFrame(() => target.scrollIntoView({ behavior: "smooth", block: "start" }));
  }));

  /* ── reserve ─────────────────────────────── */
  $$("[data-buy]").forEach((btn) => btn.addEventListener("click", () => {
    setOrder(newOrderNo());
    $$(".acks input").forEach((i) => { i.checked = false; });
    state.qty = 1;
    go("order");
  }));

  /* ── order view ────────────────────────────── */
  function renderOrder() {
    if (!state.order) return;
    $("#orderNo").textContent = state.order.no;
    updateAcks();
  }
  const updateAcks = () => { $("#toBooking").disabled = !$$(".acks input").every((i) => i.checked); };
  $$(".acks input").forEach((i) => i.addEventListener("change", updateAcks));
  $("#toBooking").addEventListener("click", () => go("book"));

  $("#copyOrder").addEventListener("click", async () => {
    const no = state.order.no;
    try { await navigator.clipboard.writeText(no); }
    catch {
      const r = document.createRange(); r.selectNodeContents($("#orderNo"));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      try { document.execCommand("copy"); } catch { /* ignore */ }
    }
    toast(t("order.copied") + " · " + no);
  });

  $("#saveOrder").addEventListener("click", async () => {
    const no = state.order.no;
    const W = 1080, H = 1350;
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const x = c.getContext("2d");
    x.fillStyle = "#F6F1E7"; x.fillRect(0, 0, W, H);
    const g = x.createRadialGradient(W / 2, 470, 40, W / 2, 470, 520);
    g.addColorStop(0, "rgba(255,250,236,1)"); g.addColorStop(1, "rgba(255,250,236,0)");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    try {
      const img = new Image(); img.src = "assets/img/sticker.svg";
      await img.decode();
      x.drawImage(img, W / 2 - 260, 170, 520, 520);
    } catch { /* image optional */ }
    const font = (w, s) => `${w} ${s}px -apple-system, BlinkMacSystemFont, "SF Pro Display", Inter, Helvetica, Arial, sans-serif`;
    x.textAlign = "center"; x.fillStyle = "#1D1B17";
    x.font = font(600, 40); x.fillText("Pyramide Göttingen", W / 2, 120);
    x.fillStyle = "#8C5E2A"; x.font = font(600, 30);
    x.fillText(t("order.label").toUpperCase().split("").join(String.fromCharCode(8202)), W / 2, 820);
    x.fillStyle = "#1D1B17"; x.font = `600 118px "SF Mono", ui-monospace, Menlo, Consolas, monospace`;
    x.fillText(no, W / 2, 960);
    x.strokeStyle = "rgba(29,27,23,.14)"; x.lineWidth = 2;
    x.beginPath(); x.moveTo(140, 1060); x.lineTo(W - 140, 1060); x.stroke();
    x.fillStyle = "#5C554B"; x.font = font(500, 34);
    x.fillText(cfg.placeName + (state.lang === "de" ? ", 2. OG" : ", 2nd floor"), W / 2, 1140);
    x.fillStyle = "#8F877A"; x.font = font(400, 28);
    x.fillText(cfg.placeAddress, W / 2, 1190);
    x.fillStyle = "#8C5E2A"; x.font = font(600, 30);
    x.fillText(t("img.rules"), W / 2, 1270);
    c.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = `Pyramide-${no}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, "image/png");
  });

  /* ── time helpers (Europe/Berlin) ──────────── */
  const tzParts = new Intl.DateTimeFormat("en-US", {
    timeZone: cfg.timezone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  function wall(ts) {
    const p = {}; for (const { type, value } of tzParts.formatToParts(new Date(ts))) p[type] = +value;
    return p;
  }
  function offsetAt(ts) {
    const p = wall(ts);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
  }
  function zonedToUtc(y, m, d, h, mi) {
    const guess = Date.UTC(y, m - 1, d, h, mi);
    let ts = guess - offsetAt(guess);
    ts = guess - offsetAt(ts);
    return ts;
  }
  const pad = (n) => String(n).padStart(2, "0");

  function buildDays() {
    const today = wall(Date.now());
    const minStart = Date.now() + cfg.leadMinutes * 60000;
    const days = [];
    for (let i = 0; i < cfg.daysAhead; i++) {
      const cal = new Date(Date.UTC(today.year, today.month - 1, today.day + i, 12));
      const y = cal.getUTCFullYear(), m = cal.getUTCMonth() + 1, d = cal.getUTCDate();
      const slots = [];
      for (let h = cfg.openHour; h < cfg.closeHour; h++) {
        for (let mi = 0; mi < 60; mi += cfg.slotMinutes) {
          const ts = zonedToUtc(y, m, d, h, mi);
          slots.push({ ts, label: pad(h) + ":" + pad(mi), past: ts < minStart });
        }
      }
      days.push({ y, m, d, cal, slots });
    }
    return days;
  }

  /* ── backend ───────────────────────────────── */
  async function rpc(fn, body) {
    const headers = { apikey: cfg.supabaseAnonKey, "Content-Type": "application/json" };
    if (cfg.supabaseAnonKey.startsWith("eyJ")) headers.Authorization = "Bearer " + cfg.supabaseAnonKey;
    const r = await fetch(`${cfg.supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error("rpc " + r.status);
    return r.json();
  }
  const api = {
    async taken(from, to) {
      if (!LIVE_DB) return store.get("demo_taken", []).filter((x) => x.ts >= from && x.ts <= to && x.order !== state.order.no).map((x) => x.ts);
      const rows = await rpc("pyramide_taken_slots", { p_from: new Date(from).toISOString(), p_to: new Date(to).toISOString(), p_order: state.order.no });
      return rows.map((r) => Date.parse(typeof r === "string" ? r : r.slot ?? r.pyramide_taken_slots));
    },
    async existing(no) {
      if (!LIVE_DB) { const b = store.get("booking:" + no); return b ? b.slot : null; }
      const res = await rpc("pyramide_get_booking", { p_order: no });
      return res && res.slot ? Date.parse(res.slot) : null;
    },
    async book({ no, slot, name, email, qty }) {
      if (!LIVE_DB) {
        const list = store.get("demo_taken", []).filter((x) => x.order !== no);
        if (list.some((x) => x.ts === slot)) return { ok: false, error: "slot_taken" };
        list.push({ ts: slot, order: no }); store.set("demo_taken", list);
        const all = store.get("demo_bookings", []).filter((b) => b.order_no !== no);
        all.push({ order_no: no, slot: new Date(slot).toISOString(), name, email: email || null, qty, lang: state.lang, picked_up: false, created_at: new Date().toISOString() });
        store.set("demo_bookings", all);
        return { ok: true };
      }
      return rpc("pyramide_book", { p_order: no, p_slot: new Date(slot).toISOString(), p_name: name, p_email: email || null, p_lang: state.lang, p_qty: qty, p_visitor: visitorId() });
    }
  };

  /* ── booking view ──────────────────────────── */
  async function enterBooking() {
    state.days = buildDays();
    state.slot = null;
    state.existing = null;
    $("#formError").hidden = true;
    $("#bookOrderNo").textContent = state.order.no;
    const saved = store.get("booking:" + state.order.no);
    if (saved && !$("#fName").value) $("#fName").value = saved.name || "";
    if (saved && !$("#fEmail").value) $("#fEmail").value = saved.email || "";
    if (saved && saved.qty) state.qty = saved.qty;
    const prof = store.get("profile");
    if (prof && !$("#fName").value) $("#fName").value = prof.name || "";
    if (prof && !$("#fEmail").value) $("#fEmail").value = prof.email || "";
    state.dayIndex = Math.max(0, state.days.findIndex((d) => d.slots.some((s) => !s.past)));
    renderBooking();
    await loadTaken();
    try {
      const ex = await api.existing(state.order.no);
      if (ex && ex > Date.now()) state.existing = ex;
    } catch { /* non-critical */ }
    renderBooking();
  }

  async function loadTaken() {
    state.loadingTaken = true; renderTimesStatus();
    try {
      const first = state.days[0].slots[0].ts;
      const lastDay = state.days[state.days.length - 1];
      const last = lastDay.slots[lastDay.slots.length - 1].ts;
      state.taken = new Set(await api.taken(first, last));
    } catch {
      toast(t("book.err.network"));
    } finally {
      state.loadingTaken = false;
    }
    renderBooking();
  }

  const isFree = (s) => !s.past && !state.taken.has(s.ts);

  function renderBooking() {
    if (!state.days.length) return;
    const L = locale();
    const wd = new Intl.DateTimeFormat(L, { weekday: "short", timeZone: "UTC" });
    const mo = new Intl.DateTimeFormat(L, { month: "short", timeZone: "UTC" });
    const monthYear = new Intl.DateTimeFormat(L, { month: "long", year: "numeric", timeZone: "UTC" });

    const daysEl = $("#days");
    daysEl.innerHTML = state.days.map((d, i) => {
      const full = !d.slots.some(isFree);
      return `<button type="button" class="day${full ? " is-full" : ""}" role="option" data-i="${i}" aria-selected="${i === state.dayIndex}">
        <span class="day-wd">${escapeHtml(wd.format(d.cal).replace(".", ""))}</span>
        <span class="day-num">${d.d}</span>
        <span class="day-mo">${escapeHtml(mo.format(d.cal).replace(".", ""))}</span>
      </button>`;
    }).join("");
    const sel = daysEl.children[state.dayIndex];
    if (sel) {
      const left = sel.offsetLeft - daysEl.offsetLeft;
      if (left < daysEl.scrollLeft || left + sel.offsetWidth > daysEl.scrollLeft + daysEl.clientWidth) daysEl.scrollTo({ left: left - 4, behavior: "smooth" });
    }

    const day = state.days[state.dayIndex];
    $("#calMonth").textContent = monthYear.format(day.cal);
    $("#dayPrev").disabled = state.dayIndex === 0;
    $("#dayNext").disabled = state.dayIndex === state.days.length - 1;

    const visible = day.slots.filter((s) => !s.past);
    const timesEl = $("#times");
    if (!visible.length) {
      timesEl.innerHTML = `<div class="times-empty">${escapeHtml(t("book.none"))}</div>`;
    } else {
      timesEl.innerHTML = visible.map((s) => {
        const taken = state.taken.has(s.ts);
        return `<button type="button" class="time" role="option" data-ts="${s.ts}" ${taken ? `disabled aria-label="${s.label} – ${escapeHtml(t("book.taken"))}"` : ""} aria-selected="${s.ts === state.slot}">${s.label}</button>`;
      }).join("");
    }
    renderTimesStatus();

    const ex = $("#existingNotice");
    ex.hidden = !state.existing;
    if (state.existing) $("#existingText").textContent = t("book.existing", { when: fmtWhen(state.existing) });

    const sum = $("#summary");
    sum.classList.toggle("is-set", !!state.slot);
    $("#summaryText").textContent = state.slot ? fmtWhen(state.slot) : t("book.pick");
    $("#confirmBtn").disabled = !state.slot;
    $("#qtyVal").textContent = state.qty;
    $("#qtyMinus").disabled = state.qty <= 1;
    $("#qtyPlus").disabled = state.qty >= cfg.maxQty;
    $("#cashTotal").textContent = money(state.qty * cfg.priceEur);
  }

  function renderTimesStatus() {
    $("#timesStatus").textContent = state.loadingTaken ? t("book.loading") : "";
  }

  function fmtWhen(ts) {
    const d = new Intl.DateTimeFormat(locale(), { timeZone: cfg.timezone, weekday: "long", day: "numeric", month: "long" }).format(ts);
    const tm = new Intl.DateTimeFormat(locale(), { timeZone: cfg.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ts);
    return `${d} · ${tm}`;
  }

  $("#days").addEventListener("click", (e) => {
    const b = e.target.closest(".day"); if (!b) return;
    state.dayIndex = +b.dataset.i;
    renderBooking();
  });
  $("#dayPrev").addEventListener("click", () => { if (state.dayIndex > 0) { state.dayIndex--; renderBooking(); } });
  $("#dayNext").addEventListener("click", () => { if (state.dayIndex < state.days.length - 1) { state.dayIndex++; renderBooking(); } });
  $("#times").addEventListener("click", (e) => {
    const b = e.target.closest(".time"); if (!b || b.disabled) return;
    state.slot = +b.dataset.ts;
    $("#formError").hidden = true;
    renderBooking();
    if (matchMedia("(max-width: 900px)").matches) $("#bookForm").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  $("#qtyMinus").addEventListener("click", () => { if (state.qty > 1) { state.qty--; renderBooking(); } });
  $("#qtyPlus").addEventListener("click", () => { if (state.qty < cfg.maxQty) { state.qty++; renderBooking(); } });

  $("#bookForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#formError");
    const showErr = (k) => { err.textContent = t(k); err.hidden = false; };
    err.hidden = true;
    const name = $("#fName").value.trim().replace(/\s+/g, " ");
    const email = $("#fEmail").value.trim();
    if (!state.slot) return showErr("book.pick");
    if (!name) { $("#fName").focus(); return showErr("book.err.name"); }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { $("#fEmail").focus(); return showErr("book.err.email"); }

    const btn = $("#confirmBtn");
    btn.classList.add("is-loading"); btn.disabled = true;
    try {
      const res = await api.book({ no: state.order.no, slot: state.slot, name, email, qty: state.qty });
      if (!res || !res.ok) {
        const code = res && res.error;
        if (code === "slot_taken") { state.taken.add(state.slot); state.slot = null; renderBooking(); showErr("book.err.taken"); loadTaken(); }
        else if (code === "invalid_order") showErr("book.err.order");
        else if (code === "already_picked_up") showErr("book.err.picked");
        else showErr("book.err.invalid");
        return;
      }
      store.set("booking:" + state.order.no, { slot: state.slot, name, email, qty: state.qty });
      store.set("profile", { name, email: email || (store.get("profile") || {}).email || "" });
      go("done");
    } catch {
      showErr("book.err.network");
    } finally {
      btn.classList.remove("is-loading");
      btn.disabled = !state.slot;
    }
  });

  /* ── done view ─────────────────────────────── */
  function renderDone() {
    const b = state.order && store.get("booking:" + state.order.no);
    if (!b) return;
    const first = (b.name || "").split(" ")[0];
    $("#doneTitle").textContent = t("done.title", { name: first });
    $("#doneDate").textContent = new Intl.DateTimeFormat(locale(), { timeZone: cfg.timezone, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(b.slot);
    $("#doneTime").textContent = new Intl.DateTimeFormat(locale(), { timeZone: cfg.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(b.slot)
      + " – " + new Intl.DateTimeFormat(locale(), { timeZone: cfg.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(b.slot + cfg.slotMinutes * 60000);
    $("#donePlace").textContent = cfg.placeName + (state.lang === "de" ? ", 2. OG" : ", 2nd floor");
    $("#doneOrder").textContent = state.order.no;
    const qty = b.qty || 1;
    $("#doneQty").textContent = `${qty} × ${money(cfg.priceEur)} = ${money(qty * cfg.priceEur)}`;
    const time = new Intl.DateTimeFormat(locale(), { timeZone: cfg.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(b.slot);
    $("#bringCash").textContent = t("done.bring.cash", { amount: money(qty * cfg.priceEur) });
    $("#bringTime").textContent = t("done.bring.time", { time });
    $("#bringOrder").textContent = t("done.bring.order", { order: state.order.no });
  }

  $("#rescheduleBtn").addEventListener("click", () => go("book"));

  $("#icsBtn").addEventListener("click", () => {
    const b = store.get("booking:" + state.order.no); if (!b) return;
    const fmt = (ts) => new Date(ts).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const place = `${cfg.placeName} (${state.lang === "de" ? "2. OG" : "2nd floor"}), ${cfg.placeAddress}`;
    const esc = (s) => s.replace(/[,;\\]/g, (c) => "\\" + c);
    const ics = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Pyramide Göttingen//Pickup//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      `UID:${state.order.no}-${b.slot}@pyramide-goettingen`,
      `DTSTAMP:${fmt(Date.now())}`,
      `DTSTART:${fmt(b.slot)}`,
      `DTEND:${fmt(b.slot + cfg.slotMinutes * 60000)}`,
      `SUMMARY:${esc(t("done.ics.title"))}`,
      `LOCATION:${esc(place)}`,
      `DESCRIPTION:${esc(t("done.ics.desc", { order: state.order.no, amount: money((b.qty || 1) * cfg.priceEur) }))}`,
      "BEGIN:VALARM", "TRIGGER:-PT1H", "ACTION:DISPLAY", `DESCRIPTION:${esc(t("done.ics.title"))}`, "END:VALARM",
      "END:VEVENT", "END:VCALENDAR"
    ].join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }));
    a.download = `Pyramide-${state.order.no}.ics`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });

  /* ── lookup dialog ─────────────────────────── */
  const dlg = $("#lookup");
  function openLookup() {
    $("#lookupError").hidden = true;
    $("#lookupInput").value = state.order ? state.order.no : "";
    if (typeof dlg.showModal === "function") { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute("open", "");
    setTimeout(() => $("#lookupInput").focus(), 50);
  }
  const closeLookup = () => (dlg.close ? dlg.close() : dlg.removeAttribute("open"));
  $$("[data-open-lookup]").forEach((b) => b.addEventListener("click", openLookup));
  $("#lookupCancel").addEventListener("click", closeLookup);
  $("#lookupBuy").addEventListener("click", () => { closeLookup(); go("shop"); window.scrollTo({ top: 0, behavior: "smooth" }); });
  dlg.addEventListener("click", (e) => { if (e.target === dlg) closeLookup(); });
  $("#lookupForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const no = normalizeOrder($("#lookupInput").value);
    if (!ORDER_RE.test(no)) { $("#lookupError").hidden = false; return; }
    setOrder(no);
    closeLookup();
    if (currentView === "book") enterBooking(); else go("book");
  });

  /* ── language switch ───────────────────────── */
  $$(".lang-btn").forEach((b) => b.addEventListener("click", () => {
    if (state.lang === b.dataset.lang) return;
    state.lang = b.dataset.lang;
    store.set("lang", state.lang);
    applyLang();
  }));

  /* ── nav shadow ────────────────────────────── */
  const nav = $("#nav");
  const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 4);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ── reveal on scroll ──────────────────────── */
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); } });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    $$(".reveal").forEach((el, i) => { el.style.transitionDelay = (el.closest(".hero") ? i * 70 : 0) + "ms"; io.observe(el); });
  } else {
    $$(".reveal").forEach((el) => el.classList.add("in"));
  }

  /* ── sticker tilt ──────────────────────────── */
  const tilt = $("#tilt");
  if (tilt && matchMedia("(pointer: fine)").matches && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const stage = tilt.parentElement;
    stage.addEventListener("pointermove", (e) => {
      const r = stage.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5, py = (e.clientY - r.top) / r.height - 0.5;
      tilt.style.transition = "transform .15s ease-out";
      tilt.style.transform = `rotateY(${px * 14}deg) rotateX(${-py * 14}deg) scale(1.02)`;
    });
    stage.addEventListener("pointerleave", () => { tilt.style.transition = ""; tilt.style.transform = ""; });
  }

  /* ── visitor stats (random id, no personal data) ── */
  function visitorId() {
    let id = store.get("vid");
    if (!id || !/^v_[a-z0-9]{16,40}$/.test(id)) {
      const b = new Uint8Array(12); crypto.getRandomValues(b);
      id = "v_" + Array.from(b, (x) => x.toString(36).padStart(2, "0")).join("").slice(0, 20);
      store.set("vid", id);
    }
    return id;
  }
  function deviceType() {
    const ua = navigator.userAgent || "";
    if (/iPad|Tablet/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "tablet";
    if (/Mobi|Android|iPhone|iPod/i.test(ua)) return "mobile";
    return "desktop";
  }
  function referrerHost() {
    try {
      const saved = sessionStorage.getItem("pyr_ref");
      if (saved !== null) return saved || null;
      const r = document.referrer ? new URL(document.referrer).hostname.replace(/^www\./, "") : "";
      const own = r === location.hostname;
      sessionStorage.setItem("pyr_ref", own ? "" : r);
      return own ? null : r || null;
    } catch { return null; }
  }
  let lastPing = 0;
  function ping() {
    if (!LIVE_DB || store.get("is_admin")) return;
    if (Date.now() - lastPing < 4000) return;
    lastPing = Date.now();
    rpc("pyramide_ping", { p_visitor: visitorId(), p_view: currentView || "shop", p_lang: state.lang, p_device: deviceType(), p_referrer: referrerHost() }).catch(() => {});
  }
  setInterval(() => { if (!document.hidden) ping(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) ping(); });

  /* ── boot ──────────────────────────────────── */
  applyLang();
  render(routeFromHash());
})();
