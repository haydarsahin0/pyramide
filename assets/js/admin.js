(() => {
  "use strict";

  const cfg = window.PYRAMIDE_CONFIG;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const LIVE_DB = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  const TZ = cfg.timezone;

  const ss = {
    get(k) { try { return sessionStorage.getItem("pyr_admin_" + k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem("pyr_admin_" + k, v); } catch { /* ignore */ } },
    del(k) { try { sessionStorage.removeItem("pyr_admin_" + k); } catch { /* ignore */ } }
  };
  const ls = {
    get(k, d) { try { const v = localStorage.getItem("pyr_" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("pyr_" + k, JSON.stringify(v)); } catch { /* ignore */ } }
  };

  const state = { pw: ss.get("pw"), rows: [], filter: "upcoming", q: "" };

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (n) => new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n);
  const dayKey = (ts) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(ts);
  const fmtDay = (ts) => new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" }).format(ts);
  const fmtTime = (ts) => new Intl.DateTimeFormat("de-DE", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ts);

  let toastTimer;
  function toast(msg) {
    const el = $("#toast"); el.textContent = msg; el.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
  }

  /* ── backend ─────────────────────────────── */
  async function rpc(fn, body) {
    const headers = { apikey: cfg.supabaseAnonKey, "Content-Type": "application/json" };
    if (cfg.supabaseAnonKey.startsWith("eyJ")) headers.Authorization = "Bearer " + cfg.supabaseAnonKey;
    const r = await fetch(`${cfg.supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error("rpc " + r.status);
    return r.json();
  }
  const api = {
    async list(pw) {
      if (!LIVE_DB) return { ok: true, rows: ls.get("demo_bookings", []) };
      return rpc("pyramide_admin_list", { p_password: pw });
    },
    async setPicked(pw, order, value) {
      if (!LIVE_DB) {
        const all = ls.get("demo_bookings", []);
        const b = all.find((x) => x.order_no === order); if (b) b.picked_up = value;
        ls.set("demo_bookings", all); return { ok: true };
      }
      return rpc("pyramide_admin_set_picked", { p_password: pw, p_order: order, p_value: value });
    },
    async remove(pw, order) {
      if (!LIVE_DB) {
        ls.set("demo_bookings", ls.get("demo_bookings", []).filter((x) => x.order_no !== order));
        ls.set("demo_taken", ls.get("demo_taken", []).filter((x) => x.order !== order));
        return { ok: true };
      }
      return rpc("pyramide_admin_delete", { p_password: pw, p_order: order });
    }
  };

  /* ── views ───────────────────────────────── */
  function showLogin(err) {
    $("#dash").hidden = true; $("#logout").hidden = true; $("#loginView").hidden = false;
    $("#loginErr").hidden = !err; if (err) $("#loginErr").textContent = err;
    setTimeout(() => $("#pw").focus(), 30);
  }
  function showDash() {
    $("#loginView").hidden = true; $("#dash").hidden = false; $("#logout").hidden = !LIVE_DB;
  }

  async function load(silent) {
    try {
      const res = await api.list(state.pw);
      if (!res || !res.ok) { ss.del("pw"); state.pw = null; return showLogin("Şifre yanlış."); }
      state.rows = (res.rows || []).map((r) => ({ ...r, ts: Date.parse(r.slot), qty: r.qty || 1 }));
      showDash();
      render();
      $("#updated").textContent = "Son güncelleme: " + fmtTime(Date.now());
      loadThreads();
      if (!chat.started) { chat.started = true; setTab(LIVE_DB ? "ovr" : "res"); }
      if (!silent) toast("Güncellendi");
    } catch {
      if (!state.rows.length) showLogin("Bağlantı kurulamadı. Tekrar dene.");
      else toast("Bağlantı kurulamadı");
    }
  }

  function inFilter(r, f, now, today) {
    const end = r.ts + cfg.slotMinutes * 60000;
    if (f === "today") return dayKey(r.ts) === today;
    if (f === "upcoming") return end >= now;
    if (f === "past") return end < now;
    return true;
  }

  function render() {
    const now = Date.now(), today = dayKey(now);
    const rows = state.rows;

    const todays = rows.filter((r) => dayKey(r.ts) === today);
    const upcoming = rows.filter((r) => r.ts + cfg.slotMinutes * 60000 >= now);
    const openCash = rows.filter((r) => !r.picked_up).reduce((s, r) => s + r.qty * cfg.priceEur, 0);
    const done = rows.filter((r) => r.picked_up);
    const sum = (a) => a.reduce((s, r) => s + r.qty, 0);

    $("#sToday").textContent = todays.length;
    $("#sTodaySub").textContent = `${sum(todays)} sticker · ${money(sum(todays.filter((r) => !r.picked_up)) * cfg.priceEur)} bekleniyor`;
    $("#sUpcoming").textContent = upcoming.length;
    $("#sUpcomingSub").textContent = `${sum(upcoming)} sticker`;
    $("#sCash").textContent = money(openCash);
    $("#sDone").textContent = done.length;
    $("#sDoneSub").textContent = `${sum(done)} sticker · ${money(sum(done) * cfg.priceEur)} alındı`;

    for (const [f, id] of [["today", "cToday"], ["upcoming", "cUpcoming"], ["past", "cPast"], ["all", "cAll"]]) {
      $("#" + id).textContent = rows.filter((r) => inFilter(r, f, now, today)).length;
    }
    $$("#filters button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.f === state.filter)));

    const q = state.q.trim().toLowerCase();
    let list = rows.filter((r) => inFilter(r, state.filter, now, today));
    if (q) list = list.filter((r) => [r.name, r.order_no, r.email].some((v) => (v || "").toLowerCase().includes(q)));
    list.sort((a, b) => (state.filter === "past" ? b.ts - a.ts : a.ts - b.ts));

    if (!list.length) {
      $("#list").innerHTML = `<div class="empty">${q ? "Aramayla eşleşen rezervasyon yok." : "Burada henüz rezervasyon yok."}</div>`;
      return;
    }

    const groups = new Map();
    for (const r of list) { const k = dayKey(r.ts); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }

    let html = `<div class="row row-head"><span>Saat</span><span>İsim</span><span>Adet</span><span>Nakit</span><span>Bestellnr.</span><span>Durum</span><span></span></div>`;
    for (const [k, items] of groups) {
      const label = fmtDay(items[0].ts);
      html += `<section class="day-group">
        <div class="day-h"><strong>${esc(label)}${k === today ? '<span class="today">Bugün</span>' : ""}</strong>
        <span>${items.length} rezervasyon · ${sum(items)} sticker · ${money(sum(items) * cfg.priceEur)}</span></div>
        <div class="rows">` +
        items.map((r) => `
          <div class="row${r.picked_up ? " done" : ""}">
            <span class="r-time">${fmtTime(r.ts)}</span>
            <span class="r-name">${esc(r.name)}${r.online ? '<span class="online-dot" title="Şu an sitede"></span>' : ""}${r.email ? `<span class="r-email"><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></span>` : ""}${r.created_at ? `<span class="r-made">Rezerve: ${esc(fmtStamp(r.created_at))}${r.has_chat ? " · sohbet var" : ""}</span>` : ""}</span>
            <span class="r-meta">
              <span class="r-qty"><span class="r-lbl">Adet</span>${r.qty} ×</span>
              <span class="r-cash"><span class="r-lbl">Nakit</span>${money(r.qty * cfg.priceEur)}</span>
              <span class="r-order"><span class="r-lbl">No</span>${esc(r.order_no)}</span>
            </span>
            <span class="r-st"><button type="button" class="status${r.picked_up ? " on" : ""}" data-pick="${esc(r.order_no)}">
              ${r.picked_up ? '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.2 4.2L19 7"/></svg>Teslim edildi' : "Teslim edilmedi"}
            </button></span>
            <button type="button" class="del" data-del="${esc(r.order_no)}" aria-label="Rezervasyonu sil" title="Rezervasyonu sil"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
          </div>`).join("") +
        `</div></section>`;
    }
    $("#list").innerHTML = html;
  }

  /* ── events ──────────────────────────────── */
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = $("#pw").value;
    if (!pw) return;
    const btn = $("#loginBtn"); btn.classList.add("is-loading");
    state.pw = pw;
    await load(true);
    btn.classList.remove("is-loading");
    if (!$("#dash").hidden) { ss.set("pw", pw); $("#pw").value = ""; }
  });
  $("#logout").addEventListener("click", () => { ss.del("pw"); state.pw = null; state.rows = []; showLogin(); });
  $("#refreshBtn").addEventListener("click", () => { load(false); if (chat.tab === "ovr") loadStats(); });
  $("#filters").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-f]"); if (!b) return;
    state.filter = b.dataset.f; render();
  });
  $("#q").addEventListener("input", (e) => { state.q = e.target.value; render(); });

  $("#list").addEventListener("click", async (e) => {
    const pick = e.target.closest("[data-pick]");
    const del = e.target.closest("[data-del]");
    if (pick) {
      const order = pick.dataset.pick;
      const r = state.rows.find((x) => x.order_no === order); if (!r) return;
      const value = !r.picked_up;
      r.picked_up = value; render();
      try {
        const res = await api.setPicked(state.pw, order, value);
        if (!res || !res.ok) throw new Error();
        toast(value ? `${order} teslim edildi` : `${order} geri alındı`);
      } catch { r.picked_up = !value; render(); toast("Kaydedilemedi"); }
    }
    if (del) {
      const order = del.dataset.del;
      const r = state.rows.find((x) => x.order_no === order); if (!r) return;
      if (!confirm(`${r.name} – ${fmtDay(r.ts)} ${fmtTime(r.ts)} (${order})\n\nBu rezervasyon silinsin mi? Saat tekrar boşa çıkar.`)) return;
      try {
        const res = await api.remove(state.pw, order);
        if (!res || !res.ok) throw new Error();
        state.rows = state.rows.filter((x) => x.order_no !== order); render();
        toast(`${order} silindi`);
      } catch { toast("Silinemedi"); }
    }
  });

  $("#csvBtn").addEventListener("click", () => {
    const head = ["Tarih", "Saat", "İsim", "E-posta", "Adet", "Nakit (EUR)", "Bestellnummer", "Teslim edildi", "Dil", "Oluşturuldu"];
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [...state.rows].sort((a, b) => a.ts - b.ts).map((r) => [
      dayKey(r.ts), fmtTime(r.ts), r.name, r.email || "", r.qty, r.qty * cfg.priceEur, r.order_no, r.picked_up ? "evet" : "hayır", r.lang || "", r.created_at || ""
    ].map(q).join(";"));
    const blob = new Blob(["﻿" + [head.map(q).join(";"), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `pyramide-rezervasyonlar-${dayKey(Date.now())}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });

  const nav = $("#nav");
  window.addEventListener("scroll", () => nav.classList.toggle("scrolled", window.scrollY > 4), { passive: true });

  // auto-refresh every minute while visible
  setInterval(() => { if (!document.hidden && !$("#dash").hidden) load(true); }, 60000);


  /* ── messages ────────────────────────────── */
  const chat = { threads: [], active: null, msgs: [], tab: "res", timer: null };
  const fmtWhen = (iso) => {
    const d = new Date(iso), now = new Date();
    if (d.toDateString() === now.toDateString()) return fmtTime(d);
    return new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, day: "numeric", month: "short" }).format(d) + " " + fmtTime(d);
  };

  async function loadThreads() {
    if (!LIVE_DB) return;
    try {
      const res = await rpc("pyramide_admin_threads", { p_password: state.pw });
      if (!res || !res.ok) return;
      chat.threads = res.rows || [];
      renderThreads();
    } catch { /* ignore, next refresh */ }
  }

  function renderThreads() {
    const unread = chat.threads.reduce((n, th) => n + (th.unread > 0 ? 1 : 0), 0);
    $("#msgBadge").hidden = !unread; $("#msgBadge").textContent = unread;
    document.title = (unread ? `(${unread}) ` : "") + "Pyramide · Admin";
    const el = $("#threads");
    if (!chat.threads.length) { el.innerHTML = '<div class="threads-empty">Henüz mesaj yok.</div>'; return; }
    el.innerHTML = chat.threads.map((th) => {
      const who = th.name || (th.email ? th.email : "Ziyaretçi");
      const last = th.last ? (th.last.sender === "admin" ? "<b>Sen:</b> " : "") + esc(th.last.body) : "";
      return `<button type="button" class="thread${th.unread > 0 ? " unread" : ""}" data-thread="${esc(th.id)}" aria-current="${th.id === chat.active}">
        <span class="thread-top"><span class="thread-name">${esc(who)}</span><span class="thread-time">${esc(fmtWhen(th.last_message_at))}</span></span>
        <span class="thread-prev">${last}</span>
        <span class="thread-tags">${th.online ? '<span class="tag green">● çevrimiçi</span>' : ""}${th.booking ? `<span class="tag gold">${th.booking.qty}× · ${esc(fmtDayShort(th.booking.slot))}${th.booking.picked_up ? " · teslim" : ""}</span>` : '<span class="tag">rezervasyon yok</span>'}</span>
      </button>`;
    }).join("");
  }

  async function openThread(id, silent) {
    chat.active = id;
    $(".inbox").classList.add("has-active");
    const th = chat.threads.find((x) => x.id === id);
    if (th) th.unread = 0;
    renderThreads();
    if (!silent) renderConvo(true);
    try {
      const res = await rpc("pyramide_admin_thread", { p_password: state.pw, p_thread: id });
      if (!res || !res.ok || chat.active !== id) return;
      const ctx = { bookings: res.bookings || [], visitor: res.visitor || null };
      const changed = JSON.stringify(res.rows) !== JSON.stringify(chat.msgs) || JSON.stringify(ctx) !== JSON.stringify(chat.ctx);
      chat.msgs = res.rows || [];
      chat.ctx = ctx;
      if (changed || !silent) renderConvo(false);
    } catch { toast("Mesajlar yüklenemedi"); }
  }

  function renderConvo(loading) {
    const th = chat.threads.find((x) => x.id === chat.active);
    const el = $("#convo");
    if (!th) { el.innerHTML = '<div class="convo-empty">Soldan bir konuşma seç.</div>'; return; }
    const draft = $("#replyInput") ? $("#replyInput").value : "";
    const meta = [
      th.email ? `<a href="mailto:${esc(th.email)}">${esc(th.email)}</a>` : "",
      th.order_no ? `<span class="mono">${esc(th.order_no)}</span>` : "",
      th.lang ? `<span>${th.lang === "de" ? "Almanca" : "İngilizce"}</span>` : "",
      `<span>${esc(fmtWhen(th.created_at))} başladı</span>`
    ].filter(Boolean).join("");
    el.innerHTML = `
      <div class="convo-head">
        <button type="button" class="icon-btn convo-back" id="convoBack" aria-label="Geri"><svg viewBox="0 0 24 24"><path d="M14.5 6l-6 6 6 6"/></svg></button>
        <div class="convo-who"><strong>${esc(th.name || "Ziyaretçi")}</strong><div class="convo-meta">${meta}</div></div>
        <button type="button" class="del" id="convoDel" title="Konuşmayı sil" aria-label="Konuşmayı sil"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
      ${loading ? "" : renderCtx()}
      <div class="convo-body" id="convoBody">${loading ? '<div class="convo-empty">Yükleniyor…</div>' :
        chat.msgs.map((m) => `<div class="bubble ${m.sender === "admin" ? "from-admin" : "from-me"}"><p>${esc(m.body).replace(/\n/g, "<br>")}</p><span class="bubble-meta">${esc(fmtWhen(m.created_at))}</span></div>`).join("")}</div>
      <form class="convo-form" id="replyForm">
        <textarea id="replyInput" rows="1" maxlength="2000" placeholder="Cevabını yaz… (Enter = gönder, Shift+Enter = yeni satır)"></textarea>
        <button class="btn btn-primary" type="submit">Gönder</button>
      </form>`;
    const body = $("#convoBody"); body.scrollTop = body.scrollHeight;
    const input = $("#replyInput"); input.value = draft;
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#replyForm").requestSubmit(); } });
    input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 160) + "px"; });
    $("#convoBack").addEventListener("click", () => { chat.active = null; $(".inbox").classList.remove("has-active"); renderThreads(); renderConvo(); });
    $("#convoDel").addEventListener("click", async () => {
      if (!confirm(`${th.name || "Ziyaretçi"} ile olan konuşma silinsin mi? Bu geri alınamaz.`)) return;
      try {
        const res = await rpc("pyramide_admin_delete_thread", { p_password: state.pw, p_thread: th.id });
        if (!res || !res.ok) throw new Error();
        chat.threads = chat.threads.filter((x) => x.id !== th.id); chat.active = null; chat.msgs = [];
        $(".inbox").classList.remove("has-active"); renderThreads(); renderConvo(); toast("Konuşma silindi");
      } catch { toast("Silinemedi"); }
    });
    $("#replyForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = input.value.trim(); if (!text) return;
      input.disabled = true;
      try {
        const res = await rpc("pyramide_admin_reply", { p_password: state.pw, p_thread: th.id, p_body: text });
        if (!res || !res.ok) throw new Error();
        input.value = "";
        th.last = { sender: "admin", body: text }; th.last_message_at = new Date().toISOString();
        await openThread(th.id, true);
        renderConvo(false);
      } catch { toast("Gönderilemedi"); }
      finally { const i = $("#replyInput"); if (i) { i.disabled = false; i.focus(); } }
    });
    if (!loading) setTimeout(() => input.focus(), 30);
  }

  $("#threads").addEventListener("click", (e) => {
    const b = e.target.closest("[data-thread]"); if (!b) return;
    chat.msgs = []; openThread(b.dataset.thread);
  });

  function setTab(tab) {
    chat.tab = tab;
    $$("#tabs button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tab === tab)));
    $("#ovrView").hidden = tab !== "ovr";
    $("#resView").hidden = tab !== "res";
    $("#msgView").hidden = tab !== "msg";
    $("#csvBtn").hidden = tab !== "res";
    $("#aTitle").textContent = { ovr: "Genel bakış", res: "Rezervasyonlar", msg: "Mesajlar" }[tab];
    if (tab === "msg") loadThreads();
    if (tab === "ovr") loadStats();
    clearInterval(chat.timer);
    chat.timer = setInterval(() => {
      if (document.hidden || $("#dash").hidden) return;
      if (chat.tab === "ovr") return loadStats();
      if (chat.tab !== "msg") return;
      loadThreads();
      if (chat.active) openThread(chat.active, true);
    }, tab === "ovr" ? 15000 : 10000);
  }
  $("#tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) setTab(b.dataset.tab); });

  /* ── overview ────────────────────────────── */
  const VIEW_TR = { shop: "Ana sayfada", order: "Bestellnummer ekranında", book: "Takvimde, saat seçiyor", done: "Onay ekranında" };
  const DEV_TR = { mobile: "Telefon", tablet: "Tablet", desktop: "Bilgisayar", unknown: "Bilinmiyor" };
  const LANG_TR = { de: "Almanca", en: "İngilizce", unknown: "Bilinmiyor" };
  const DEV_ICON = {
    mobile: '<svg viewBox="0 0 24 24"><rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/></svg>',
    tablet: '<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M11 18h2"/></svg>',
    desktop: '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M9 20h6M12 16.5V20"/></svg>'
  };
  function fmtStamp(iso) {
    const d = new Date(iso);
    return new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, day: "numeric", month: "short" }).format(d) + " " + fmtTime(d);
  }
  function fmtDayShort(iso) {
    const d = new Date(iso);
    return new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" }).format(d) + " " + fmtTime(d);
  }
  function ago(iso) {
    const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
    if (m < 1) return "az önce";
    if (m < 60) return m + " dk";
    const h = Math.floor(m / 60);
    if (h < 24) return h + " sa " + (m % 60) + " dk";
    return Math.floor(h / 24) + " gün";
  }

  function renderCtx() {
    const c = chat.ctx || { bookings: [], visitor: null };
    const b = c.bookings || [];
    const v = c.visitor;
    const bookingsHtml = b.length ? b.map((x) => `
      <div class="ctx-booking">
        <div class="ctx-line"><span>Bestellnummer</span><span class="mono">${esc(x.order_no)}</span></div>
        <div class="ctx-line"><span>Adet · nakit</span><span>${x.qty} × = ${money(x.qty * cfg.priceEur)}</span></div>
        <div class="ctx-line"><span>Teslim randevusu</span><span>${esc(fmtDayShort(x.slot))}</span></div>
        <div class="ctx-line"><span>Rezervasyon yaptı</span><span>${esc(fmtStamp(x.created_at))}</span></div>
        <div class="ctx-line"><span>Durum</span><span>${x.picked_up ? "✓ teslim edildi" : Date.parse(x.slot) < Date.now() ? "randevu geçti" : "bekliyor"}</span></div>
      </div>`).join("") : '<p class="ctx-none">Bu kişinin rezervasyonu yok.</p>';
    const visitorHtml = v ? `
      <div class="ctx-line"><span>Durum</span><span>${v.online ? '<span class="tag green">● şu an sitede</span>' : "son görülme " + esc(ago(v.last_seen)) + " önce"}</span></div>
      ${v.online ? `<div class="ctx-line"><span>Şu an</span><span>${esc(VIEW_TR[v.view] || v.view || "–")}</span></div>` : ""}
      <div class="ctx-line"><span>İlk ziyaret</span><span>${esc(fmtStamp(v.first_seen))}</span></div>
      <div class="ctx-line"><span>Geldiği gün sayısı</span><span>${v.days}</span></div>
      <div class="ctx-line"><span>Cihaz · dil</span><span>${esc(DEV_TR[v.device] || "–")} · ${esc(LANG_TR[v.lang] || "–")}</span></div>
      <div class="ctx-line"><span>Nereden geldi</span><span>${esc(v.referrer || "doğrudan")}</span></div>` : '<p class="ctx-none">Ziyaret bilgisi yok (eski sohbet).</p>';
    return `<div class="convo-ctx">
      <div class="ctx-box"><div class="ctx-k"><span>Sipariş</span><span>${b.length ? b.length + " rezervasyon" : ""}</span></div>${bookingsHtml}</div>
      <div class="ctx-box"><div class="ctx-k"><span>Ziyaretçi</span></div>${visitorHtml}</div>
    </div>`;
  }

  async function loadStats() {
    if (!LIVE_DB) return;
    try {
      const s = await rpc("pyramide_admin_stats", { p_password: state.pw });
      if (!s || !s.ok) return;
      renderStats(s);
    } catch { /* next tick */ }
  }

  function barChart(el, items, opts) {
    const max = Math.max(1, ...items.map((i) => i.v));
    el.innerHTML = `<div class="bars">${items.map((i, idx) => `
        <div class="bar-col${i.today ? " today" : ""}" data-i="${idx}">
          ${i.v && i.showTop ? `<span class="bar-top" style="bottom:calc(${(i.v / max) * 100}% + 3px)">${i.v}</span>` : ""}
          <div class="bar${i.v ? "" : " zero"}" style="height:${(i.v / max) * 100}%"></div>
        </div>`).join("")}</div>
      <div class="x-labels">${items.map((i) => `<span>${esc(i.label)}</span>`).join("")}</div>
      ${opts.sub ? `<div class="r-labels">${items.map((i) => `<span class="${i.sub ? "has" : ""}">${i.sub || "·"}</span>`).join("")}</div><div class="r-legend">${esc(opts.sub)}</div>` : ""}`;
    const tip = document.createElement("div"); tip.className = "tip"; tip.hidden = true; el.appendChild(tip);
    el.querySelectorAll(".bar-col").forEach((col) => {
      col.addEventListener("mouseenter", () => {
        const i = items[+col.dataset.i];
        tip.innerHTML = opts.tip(i);
        const r = col.getBoundingClientRect(), pr = el.getBoundingClientRect();
        const barH = (i.v / max) * col.offsetHeight;
        tip.style.left = Math.min(Math.max(r.left - pr.left + r.width / 2, 60), pr.width - 60) + "px";
        tip.style.top = (col.offsetTop + col.offsetHeight - barH - (i.showTop && i.v ? 18 : 0)) + "px";
        tip.hidden = false;
      });
      col.addEventListener("mouseleave", () => { tip.hidden = true; });
    });
  }

  function hbars(el, rows, names) {
    if (!rows.length) { el.innerHTML = '<p class="o-empty">Henüz veri yok.</p>'; return; }
    const total = rows.reduce((a, r) => a + r.n, 0) || 1;
    const max = Math.max(...rows.map((r) => r.n));
    el.innerHTML = rows.map((r) => `
      <div class="hbar" title="${esc((names[r.key] || r.key))}: ${r.n} (%${Math.round((r.n / total) * 100)})">
        <span class="hbar-k">${esc(names[r.key] || (r.key === "direct" ? "Doğrudan" : r.key))}</span>
        <span class="hbar-track"><span class="hbar-fill" style="display:block;width:${(r.n / max) * 100}%"></span></span>
        <span class="hbar-v">${r.n}</span>
      </div>`).join("");
  }

  function renderStats(s) {
    $("#oNow").textContent = s.active_now;
    $("#oToday").textContent = s.today;
    $("#oTodaySub").textContent = `dün ${s.yesterday} · bugün ilk kez gelen ${s.new_today}`;
    $("#oWeek").textContent = s.last7;
    $("#oWeekSub").textContent = `son 30 gün ${s.last30} kişi`;
    const conv = s.last7 ? Math.round((s.booked_visitors7 / s.last7) * 1000) / 10 : 0;
    $("#oConv").textContent = s.last7 ? "%" + conv.toLocaleString("tr-TR") : "–";
    $("#oConvSub").textContent = `7 günde ${s.bookings7} rezervasyon · bugün ${s.bookings_today} · bugün ${s.chats_today} sohbet`;

    const live = s.active || [];
    $("#oLiveNote").textContent = live.length ? `${live.length} kişi · 15 sn'de bir yenilenir` : "15 sn'de bir yenilenir";
    $("#oLive").innerHTML = live.length ? live.map((v) => `
      <div class="live-row">
        <span class="live-ic">${DEV_ICON[v.device] || DEV_ICON.desktop}</span>
        <div class="live-main">
          <strong>${esc(VIEW_TR[v.view] || "Ana sayfada")}</strong>
          <div class="live-sub">${esc(DEV_TR[v.device] || "Cihaz ?")} · ${esc(LANG_TR[v.lang] || "dil ?")} · ${esc(ago(v.session_started))} önce geldi · ${esc(v.referrer || "doğrudan")}</div>
        </div>
        <span class="tags">
          ${v.booking ? `<span class="tag gold">Rezervasyonu var · ${v.booking.qty}× · ${esc(fmtDayShort(v.booking.slot))}</span>` : ""}
          ${v.chat ? '<span class="tag">Sohbet</span>' : ""}
          ${v.returning ? `<span class="tag">Tekrar gelen · ${v.days}. gün</span>` : '<span class="tag green">Yeni</span>'}
        </span>
      </div>`).join("") : '<p class="o-empty">Şu an sitede kimse yok.</p>';

    const todayKey = dayKey(Date.now());
    const daily = (s.daily || []).map((d) => {
      const dt = new Date(d.day + "T12:00:00Z");
      return {
        v: d.visitors, sub: d.bookings, today: d.day === todayKey, showTop: true,
        label: new Intl.DateTimeFormat("tr-TR", { day: "numeric", timeZone: "UTC" }).format(dt),
        full: new Intl.DateTimeFormat("tr-TR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(dt)
      };
    });
    barChart($("#oDaily"), daily, { sub: "alttaki satır: o gün yapılan rezervasyon", tip: (i) => `<b>${esc(i.full)}</b><br>${i.v} ziyaretçi · ${i.sub} rezervasyon` });

    const nowH = +new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(new Date());
    const hours = (s.hours_today || []).filter((h) => h.hour >= 8 && h.hour <= 23).map((h) => ({
      v: h.visitors, today: h.hour === nowH, showTop: false, label: h.hour % 2 === 0 ? String(h.hour).padStart(2, "0") : "",
      full: `${String(h.hour).padStart(2, "0")}:00 – ${String(h.hour + 1).padStart(2, "0")}:00`
    }));
    barChart($("#oHours"), hours, { tip: (i) => `<b>${esc(i.full)}</b><br>${i.v} ziyaretçi` });

    hbars($("#oDevices"), s.devices || [], DEV_TR);
    hbars($("#oLangs"), s.langs || [], LANG_TR);
    hbars($("#oRefs"), s.referrers || [], {});
  }

  /* ── boot ────────────────────────────────── */
  try { localStorage.setItem("pyr_is_admin", "true"); } catch { /* ignore */ }
  $("#previewBanner").hidden = LIVE_DB;
  if (!LIVE_DB) $("#tabs").hidden = true;
  if (!LIVE_DB) load(true);
  else if (state.pw) load(true);
  else showLogin();
})();
