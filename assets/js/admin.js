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

  const cash = (rows) => rows.reduce((s, r) => s + cfg.total(r.qty || 1, r.express), 0);
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
      notifyExpress(state.rows);
      renderBc();
      if (!loadBcHist.done) { loadBcHist.done = true; loadBcHist(); }
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
    const openCash = cash(rows.filter((r) => !r.picked_up));
    const done = rows.filter((r) => r.picked_up);
    const sum = (a) => a.reduce((s, r) => s + r.qty, 0);

    $("#sToday").textContent = todays.length;
    $("#sTodaySub").textContent = `${sum(todays)} sticker · ${money(cash(todays.filter((r) => !r.picked_up)))} bekleniyor`;
    $("#sUpcoming").textContent = upcoming.length;
    $("#sUpcomingSub").textContent = `${sum(upcoming)} sticker`;
    $("#sCash").textContent = money(openCash);
    $("#sDone").textContent = done.length;
    $("#sDoneSub").textContent = `${sum(done)} sticker · ${money(cash(done))} alındı`;

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
        <span>${items.length} rezervasyon · ${sum(items)} sticker · ${money(cash(items))}</span></div>
        <div class="rows">` +
        items.map((r) => `
          <div class="row${r.picked_up ? " done" : ""}">
            <span class="r-time">${r.express ? `${fmtTime(r.ts)}<small class="r-made">bis ${fmtTime(r.ts + cfg.expressWindowMinutes * 60000)}</small><span class="exp-badge">⚡ EXPRESS</span>` : fmtTime(r.ts)}</span>
            <span class="r-name">${esc(r.name)}${r.online ? '<span class="online-dot" title="Şu an sitede"></span>' : ""}${r.email ? `<span class="r-email"><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></span>` : ""}<span class="r-msg" data-msg="${esc(r.order_no)}">✉ Mesaj gönder</span>${r.created_at ? `<span class="r-made">Rezerve: ${esc(fmtStamp(r.created_at))}${r.has_chat ? " · sohbet var" : ""}</span>` : ""}</span>
            <span class="r-meta">
              <span class="r-qty"><span class="r-lbl">Adet</span>${r.qty} ×</span>
              <span class="r-cash"><span class="r-lbl">Nakit</span>${money(cfg.total(r.qty, r.express))}</span>
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
        toast(`${order} silindi`); rtPing("site");
      } catch { toast("Silinemedi"); }
    }
  });

  $("#csvBtn").addEventListener("click", () => {
    const head = ["Tarih", "Saat", "İsim", "E-posta", "Adet", "Nakit (EUR)", "Express", "Bestellnummer", "Teslim edildi", "Dil", "Oluşturuldu"];
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [...state.rows].sort((a, b) => a.ts - b.ts).map((r) => [
      dayKey(r.ts), fmtTime(r.ts), r.name, r.email || "", r.qty, cfg.total(r.qty, r.express), r.express ? "evet" : "hayır", r.order_no, r.picked_up ? "evet" : "hayır", r.lang || "", r.created_at || ""
    ].map(q).join(";"));
    const blob = new Blob(["﻿" + [head.map(q).join(";"), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `pyramide-rezervasyonlar-${dayKey(Date.now())}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });

  const nav = $("#nav");
  window.addEventListener("scroll", () => nav.classList.toggle("scrolled", window.scrollY > 4), { passive: true });

  // auto-refresh every minute while visible
  setInterval(() => { if (!$("#dash").hidden) load(true); }, 30000);


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
        <span class="thread-tags">${th.online ? '<span class="tag green">● çevrimiçi</span>' : ""}${th.booking ? `<span class="tag gold">${th.booking.express ? "⚡ " : ""}${th.booking.qty}× · ${esc(fmtDayShort(th.booking.slot))}${th.booking.picked_up ? " · teslim" : ""}</span>` : '<span class="tag">rezervasyon yok</span>'}</span>
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
      try {
        const orders = [...new Set(ctx.bookings.map((b) => b.order_no).concat(th && th.order_no ? [th.order_no] : []))];
        const nr = orders.length ? await rpc("pyramide_admin_order_notices", { p_password: state.pw, p_orders: orders }) : null;
        chat.notices = (nr && nr.ok && nr.rows) || [];
      } catch { chat.notices = []; }
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
        chat.msgs.map((m) => ({ ...m })).concat((chat.notices || []).map((n) => ({ sender: "admin", notice: true, id: n.id, body: n.body, created_at: n.created_at, seen_at: n.seen_at })))
          .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
          .map((m) => `<div class="bubble ${m.sender === "admin" ? "from-admin" : "from-me"}${m.notice ? " is-notice" : ""}"><button type="button" class="bubble-del" ${m.notice ? `data-delnotice="${m.id}"` : `data-delmsg="${m.id}"`} title="Bu mesajı sil" aria-label="Bu mesajı sil">✕</button><p>${m.notice ? "📣 " : ""}${esc(m.body).replace(/\n/g, "<br>")}</p><span class="bubble-meta">${m.notice ? (m.seen_at ? "duyuru · okundu · " : "duyuru · ") : ""}${esc(fmtWhen(m.created_at))}</span></div>`).join("")}</div>
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
        $(".inbox").classList.remove("has-active"); renderThreads(); renderConvo(); toast("Konuşma silindi"); rtPing("site");
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
        rtPing("site");
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
    $("#expView").hidden = tab !== "exp";
    $("#resView").hidden = tab !== "res";
    $("#msgView").hidden = tab !== "msg";
    $("#csvBtn").hidden = tab !== "res";
    $("#aTitle").textContent = { ovr: "Genel bakış", res: "Rezervasyonlar", msg: "Mesajlar", exp: "Teslim saatleri" }[tab];
    if (tab === "exp") { loadExpress(); loadHours(); }
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
        <div class="ctx-line"><span>Adet · nakit</span><span>${x.qty} adet${x.express ? " + Express" : ""} = ${money(cfg.total(x.qty, x.express))}</span></div>
        <div class="ctx-line"><span>Teslim randevusu</span><span>${esc(fmtDayShort(x.slot))}${x.express ? '<span class="exp-badge">⚡ EXPRESS</span>' : ""}</span></div>
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
          ${v.booking ? `<span class="tag gold">${v.booking.express ? "⚡ Express · " : "Rezervasyonu var · "}${v.booking.qty}× · ${esc(fmtDayShort(v.booking.slot))}</span>` : ""}
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

  /* ── live sync + deleting messages ─────── */
  const rtPing = (scope) => { if (window.PyrRT) window.PyrRT.ping(scope); };
  let rtT = null;
  if (window.PyrRT) window.PyrRT.on((p) => {
    if (p.scope !== "admin" || $("#dash").hidden) return;
    clearTimeout(rtT);
    rtT = setTimeout(() => { load(true); if (chat.active) openThread(chat.active, true); }, 250);
  });

  async function delAction(fn, args, okMsg) {
    try {
      const res = await rpc(fn, Object.assign({ p_password: state.pw }, args));
      if (!res || !res.ok) throw new Error();
      toast(okMsg); rtPing("site");
      return true;
    } catch { toast("Silinemedi"); return false; }
  }
  $("#convo").addEventListener("click", async (e) => {
    const m = e.target.closest("[data-delmsg]"), n = e.target.closest("[data-delnotice]");
    if (!m && !n) return;
    if (!confirm("Bu mesaj silinsin mi? Müşterinin ekranından da silinir.")) return;
    const ok = m
      ? await delAction("pyramide_admin_delete_message", { p_id: +m.dataset.delmsg }, "Mesaj silindi")
      : await delAction("pyramide_admin_delete_notice", { p_id: +n.dataset.delnotice }, "Duyuru silindi");
    if (ok && chat.active) { await loadThreads(); openThread(chat.active, true); }
  });
  $("#bcHist").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-delbc]"); if (!b) return;
    if (!confirm("Bu duyuru tüm alıcılardan silinsin mi?")) return;
    if (await delAction("pyramide_admin_delete_broadcast", { p_id: +b.dataset.delbc }, "Duyuru herkesten silindi")) loadBcHist();
  });
  $$("[data-purge]").forEach((b) => b.addEventListener("click", async () => {
    const what = b.dataset.purge;
    const label = { chats: "TÜM SOHBETLER", notices: "TÜM DUYURULAR", all: "TÜM SOHBETLER VE DUYURULAR" }[what];
    const typed = prompt(`${label} kalıcı olarak silinecek (müşterilerin ekranından da).\nOnaylamak için SIL yaz:`);
    if ((typed || "").trim().toUpperCase() !== "SIL") return;
    if (await delAction("pyramide_admin_purge", { p_what: what }, "Silindi")) {
      chat.active = null; chat.msgs = []; chat.notices = [];
      const ib = document.querySelector(".inbox"); if (ib) ib.classList.remove("has-active");
      await loadThreads(); renderConvo(); loadBcHist();
    }
  }));

  /* ── broadcast to waiting customers ─────── */
  const bc = { aud: "today", single: null };
  const waiting = (aud) => state.rows.filter((r) => !r.picked_up
    && (r.express ? r.ts + cfg.expressWindowMinutes * 60000 : r.ts + cfg.slotMinutes * 60000) > Date.now()
    && (aud === "today" ? dayKey(r.ts) === dayKey(Date.now()) : aud === "express" ? r.express : true));
  function renderBc() {
    if (!$("#bcAudience")) return;
    $("#bcCountToday").textContent = waiting("today").length;
    $("#bcCountAll").textContent = waiting("upcoming").length;
    $("#bcCountXp").textContent = waiting("express").length;
    const sb = $("#bcSingleBtn");
    sb.hidden = !bc.single;
    if (bc.single) sb.textContent = "Tek kişi: " + bc.single.name;
    $$("#bcAudience button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.aud === bc.aud)));
    const list = bc.aud === "single" && bc.single ? [bc.single] : waiting(bc.aud);
    $("#bcTo").textContent = list.length
      ? `Alıcılar (${list.length}): ` + list.slice(0, 12).map((r) => `${r.name} (${fmtTime(r.ts)})`).join(", ") + (list.length > 12 ? " …" : "")
      : "Bu grupta bekleyen müşteri yok.";
    $("#bcSend").textContent = list.length ? `Gönder (${list.length} kişiye)` : "Gönder";
    $("#bcSend").disabled = !list.length;
  }
  async function loadBcHist() {
    try {
      const res = await rpc("pyramide_admin_broadcasts", { p_password: state.pw });
      if (!res || !res.ok) return;
      const AUD = { today: "Bugün bekleyenler", upcoming: "Tüm bekleyenler", express: "Express" };
      $("#bcHist").innerHTML = (res.rows || []).slice(0, 8).map((b) => `
        <div class="bc-item"><p>${esc(b.body)}</p><span class="bc-stat">${b.seen}/${b.recipients} okudu<button type="button" class="bc-del" data-delbc="${b.id}">Sil</button></span>
        <small>${esc(fmtStamp(b.created_at))} · ${esc(AUD[b.audience] || "Tek kişi")} · ${esc((b.names || []).slice(0, 6).join(", "))}${(b.names || []).length > 6 ? " …" : ""}</small></div>`).join("");
    } catch { /* ignore */ }
  }
  $("#bcAudience").addEventListener("click", (e) => {
    const b = e.target.closest("[data-aud]"); if (!b) return;
    bc.aud = b.dataset.aud; renderBc();
  });
  $$("[data-tpl]").forEach((b) => b.addEventListener("click", () => {
    let txt = b.dataset.tpl;
    if (b.dataset.ask) {
      const v = (prompt(b.dataset.ask) || "").trim();
      if (!v) return;
      txt = txt.split("{x}").join(v);
    }
    const ta = $("#bcText"); ta.value = txt; ta.focus();
  }));
  $("#list").addEventListener("click", (e) => {
    const m = e.target.closest("[data-msg]"); if (!m) return;
    const r = state.rows.find((x) => x.order_no === m.dataset.msg); if (!r) return;
    bc.single = r; bc.aud = "single"; renderBc();
    document.querySelector(".bc-card").scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => $("#bcText").focus(), 350);
  });
  $("#bcSend").addEventListener("click", async () => {
    const text = $("#bcText").value.trim();
    if (!text) { $("#bcText").focus(); return toast("Önce mesajı yaz"); }
    const single = bc.aud === "single" && bc.single;
    const n = single ? 1 : waiting(bc.aud).length;
    if (!confirm(`Bu mesaj ${n} kişiye gidecek:\n\n${text}`)) return;
    const btn = $("#bcSend"); btn.disabled = true;
    try {
      const res = single
        ? await rpc("pyramide_admin_notify", { p_password: state.pw, p_order: bc.single.order_no, p_body: text })
        : await rpc("pyramide_admin_broadcast", { p_password: state.pw, p_body: text, p_audience: bc.aud });
      if (!res || !res.ok) throw new Error(res && res.error);
      toast(`Gönderildi – ${res.recipients} kişi`); rtPing("site");
      $("#bcText").value = ""; bc.single = null; if (bc.aud === "single") bc.aud = "today";
      renderBc(); loadBcHist();
    } catch (ex) { toast(ex.message === "no_recipients" ? "Bekleyen müşteri yok" : "Gönderilemedi"); }
    finally { btn.disabled = false; renderBc(); }
  });

  /* ── new Express booking alert ────────────── */
  const seenXp = new Set(); let xpPrimed = false;
  function notifyExpress(rows) {
    const fresh = rows.filter((r) => r.express && !r.picked_up && r.ts + cfg.expressWindowMinutes * 60000 > Date.now());
    const news = xpPrimed ? fresh.filter((r) => !seenXp.has(r.order_no)) : [];
    fresh.forEach((r) => seenXp.add(r.order_no));
    xpPrimed = true;
    if (!news.length) return;
    const r = news[news.length - 1];
    document.querySelector(".xp-alert")?.remove();
    const el = document.createElement("div"); el.className = "xp-alert"; el.setAttribute("role", "alert");
    el.innerHTML = `<span>⚡ <b>Yeni Express:</b> ${esc(r.name)} · ${r.qty} adet · ${money(cfg.total(r.qty, true))} · ${fmtTime(r.ts + cfg.expressWindowMinutes * 60000)}'e kadar gelecek</span><button type="button">Tamam</button>`;
    el.querySelector("button").addEventListener("click", () => { el.remove(); document.title = "Pyramide · Admin"; });
    document.body.appendChild(el);
    document.title = "⚡ Yeni Express! · Pyramide";
    try { const a = new AudioContext(), o = a.createOscillator(), g = a.createGain(); o.connect(g); g.connect(a.destination); o.frequency.value = 880; g.gain.setValueAtTime(.12, a.currentTime); g.gain.exponentialRampToValueAtTime(.0001, a.currentTime + .6); o.start(); o.stop(a.currentTime + .6); } catch { /* sound optional */ }
    if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
  }

  /* ── standard pickup hours ───────────────── */
  const sh = { week: null, overrides: new Map(), timer: null, dayTimers: {} };
  const WEEK_TR = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"];
  async function loadHours() {
    try {
      const res = await rpc("pyramide_admin_hours", { p_password: state.pw });
      if (!res || !res.ok) return;
      sh.week = res.week || {};
      sh.overrides = new Map((res.overrides || []).map((o) => [o.day, new Set(o.hours)]));
      renderHours();
    } catch { toast("Saatler yüklenemedi"); }
  }
  const weekSet = (iso) => new Set((sh.week && sh.week[String(iso)]) || []);
  const isoDow = (key) => { const d = new Date(key + "T12:00:00Z").getUTCDay(); return d === 0 ? 7 : d; };
  const effective = (key) => sh.overrides.get(key) || weekSet(isoDow(key));
  function gridHead() {
    let h = "<span></span>";
    for (let x = EXP_FROM; x <= EXP_TO; x++) h += `<span class="hh">${String(x).padStart(2, "0")}</span>`;
    return h + "<span></span>";
  }
  function renderHours() {
    if (!sh.week) return;
    let w = gridHead();
    for (let i = 1; i <= 7; i++) {
      const set = weekSet(i);
      w += `<span class="dl">${WEEK_TR[i - 1]}</span>`;
      for (let h = EXP_FROM; h <= EXP_TO; h++) w += `<button type="button" class="cell" data-wd="${i}" data-hour="${h}" aria-pressed="${set.has(h)}"></button>`;
      w += `<span class="row-acts"><button type="button" data-wrow="${i}" data-act="std">10–20</button><button type="button" data-wrow="${i}" data-act="none">Kapat</button></span>`;
    }
    $("#weekGrid").innerHTML = w;

    const now = berlinNow();
    const booked = new Set(state.rows.filter((r) => !r.express).map((r) => {
      const p = {}; for (const { type, value } of new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" }).formatToParts(new Date(r.ts))) p[type] = value;
      return `${p.year}-${p.month}-${p.day}|${+p.hour}`;
    }));
    let g = gridHead();
    for (let i = 0; i < 14; i++) {
      const key = addDays(now.day, i);
      const d = new Date(key + "T12:00:00Z");
      const wd = new Intl.DateTimeFormat("tr-TR", { weekday: "short", timeZone: "UTC" }).format(d);
      const dm = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short", timeZone: "UTC" }).format(d);
      const custom = sh.overrides.has(key);
      const set = effective(key);
      g += `<span class="dl${custom ? " custom" : ""}">${i === 0 ? "Bugün" : i === 1 ? "Yarın" : esc(wd)}<small>${esc(dm)}</small></span>`;
      for (let h = EXP_FROM; h <= EXP_TO; h++) {
        const past = i === 0 && h < now.hour;
        g += `<button type="button" class="cell${past ? " past" : ""}${booked.has(key + "|" + h) ? " booked" : ""}" data-sday="${key}" data-hour="${h}" aria-pressed="${set.has(h)}" title="${esc(dm)} ${String(h).padStart(2, "0")}:00 / :30${booked.has(key + "|" + h) ? " · rezervasyon var" : ""}"></button>`;
      }
      g += `<span class="row-acts"><button type="button" data-srow="${key}" data-act="none">Kapat</button><button type="button" data-srow="${key}" data-act="reset" class="${custom ? "on" : ""}">Haftalık</button></span>`;
    }
    $("#stdGrid").innerHTML = g;
  }
  function stdStatus(msg) { $("#stdStatus").textContent = msg; }
  function saveWeek() {
    clearTimeout(sh.timer); stdStatus("Kaydediliyor…");
    sh.timer = setTimeout(async () => {
      try {
        const res = await rpc("pyramide_admin_set_week", { p_password: state.pw, p_week: sh.week });
        if (!res || !res.ok) throw new Error();
        sh.week = res.week; renderHours(); stdStatus("Haftalık saatler kaydedildi – sitede güncel."); toast("Kaydedildi – sitede güncel"); rtPing("site");
      } catch { toast("Kaydedilemedi"); loadHours(); }
    }, 400);
  }
  function saveStdDay(key, hours) {
    clearTimeout(sh.dayTimers[key]); stdStatus("Kaydediliyor…");
    sh.dayTimers[key] = setTimeout(async () => {
      try {
        const res = await rpc("pyramide_admin_set_std_day", { p_password: state.pw, p_day: key, p_hours: hours });
        if (!res || !res.ok) throw new Error();
        stdStatus("Kaydedildi – sitede güncel."); toast("Kaydedildi – sitede güncel"); rtPing("site");
      } catch { toast("Kaydedilemedi"); loadHours(); }
    }, 350);
  }
  $("#weekGrid").addEventListener("click", (e) => {
    const c = e.target.closest(".cell"), r = e.target.closest("[data-wrow]");
    if (c) {
      const k = c.dataset.wd, h = +c.dataset.hour, set = weekSet(k);
      set.has(h) ? set.delete(h) : set.add(h);
      sh.week[k] = [...set].sort((a, b) => a - b);
    } else if (r) {
      sh.week[r.dataset.wrow] = r.dataset.act === "std" ? [10, 11, 12, 13, 14, 15, 16, 17, 18, 19] : [];
    } else return;
    renderHours(); saveWeek();
  });
  $("#stdGrid").addEventListener("click", (e) => {
    const c = e.target.closest(".cell"), r = e.target.closest("[data-srow]");
    if (c) {
      const key = c.dataset.sday, h = +c.dataset.hour;
      const set = new Set(effective(key));
      set.has(h) ? set.delete(h) : set.add(h);
      sh.overrides.set(key, set);
      renderHours(); saveStdDay(key, [...set].sort((a, b) => a - b));
    } else if (r) {
      const key = r.dataset.srow;
      if (r.dataset.act === "reset") { sh.overrides.delete(key); renderHours(); saveStdDay(key, null); }
      else { sh.overrides.set(key, new Set()); renderHours(); saveStdDay(key, []); }
    }
  });

  /* ── express availability ───────────────── */
  const ex = { enabled: false, hours: new Map(), timers: {}, loaded: false };
  const EXP_FROM = 7, EXP_TO = 23;
  const berlinNow = () => {
    const p = {}; for (const { type, value } of new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" }).formatToParts(new Date())) p[type] = value;
    return { day: `${p.year}-${p.month}-${p.day}`, hour: +p.hour };
  };
  const addDays = (key, n) => { const d = new Date(key + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

  async function loadExpress() {
    try {
      const res = await rpc("pyramide_admin_express", { p_password: state.pw });
      if (!res || !res.ok) return;
      ex.enabled = !!res.enabled;
      ex.hours = new Map();
      for (const r of res.hours || []) { if (!ex.hours.has(r.day)) ex.hours.set(r.day, new Set()); ex.hours.get(r.day).add(r.hour); }
      ex.loaded = true;
      renderExpress();
    } catch { toast("Express ayarları yüklenemedi"); }
  }

  function expStatus(msg, on) { const el = $("#expStatus"); el.textContent = msg; el.classList.toggle("on", !!on); }

  function renderExpress() {
    $("#expFeeTxt").textContent = "+" + money(cfg.expressFeeEur);
    $("#expSwitch").setAttribute("aria-checked", String(ex.enabled));
    const now = berlinNow();
    const booked = new Set(state.rows.filter((r) => r.express).map((r) => {
      const p = {}; for (const { type, value } of new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" }).formatToParts(new Date(r.ts))) p[type] = value;
      return `${p.year}-${p.month}-${p.day}|${+p.hour}`;
    }));
    let html = '<span></span>';
    for (let h = EXP_FROM; h <= EXP_TO; h++) html += `<span class="hh">${String(h).padStart(2, "0")}</span>`;
    html += '<span></span>';
    for (let i = 0; i < 14; i++) {
      const key = addDays(now.day, i);
      const d = new Date(key + "T12:00:00Z");
      const wd = new Intl.DateTimeFormat("tr-TR", { weekday: "short", timeZone: "UTC" }).format(d);
      const dm = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short", timeZone: "UTC" }).format(d);
      html += `<span class="dl">${i === 0 ? "Bugün" : i === 1 ? "Yarın" : esc(wd)}<small>${esc(dm)}</small></span>`;
      const set = ex.hours.get(key) || new Set();
      for (let h = EXP_FROM; h <= EXP_TO; h++) {
        const past = i === 0 && h < now.hour;
        html += `<button type="button" class="cell${past ? " past" : ""}${booked.has(key + "|" + h) ? " booked" : ""}" data-day="${key}" data-hour="${h}" aria-pressed="${set.has(h)}" title="${esc(dm)} ${String(h).padStart(2, "0")}:00–${String(h + 1).padStart(2, "0")}:00"></button>`;
      }
      html += `<span class="row-acts"><button type="button" data-row="${key}" data-act="all">Tümü</button><button type="button" data-row="${key}" data-act="none">Temizle</button></span>`;
    }
    $("#expGrid").innerHTML = html;
    const openToday = (ex.hours.get(now.day) || new Set());
    const upcoming = [...openToday].filter((h) => h >= now.hour).sort((a, b) => a - b);
    if (!ex.enabled) expStatus("Express şu an kapalı – sitede görünmüyor.");
    else if (upcoming.length) expStatus(upcoming[0] === now.hour ? `Express şu an AÇIK – müşteriler 1 saat içinde teslim alabilir. Bugün açık saatler: ${upcoming.map((h) => String(h).padStart(2, "0") + ":00").join(", ")}` : `Express açık · bugün ${upcoming.map((h) => String(h).padStart(2, "0") + ":00").join(", ")} saatlerinde sitede görünecek.`, true);
    else expStatus("Express açık · bugün için açık saat yok. Aşağıdan saat seç.");
  }

  function saveDay(day) {
    clearTimeout(ex.timers[day]);
    expStatus("Kaydediliyor…");
    ex.timers[day] = setTimeout(async () => {
      try {
        const hours = [...(ex.hours.get(day) || [])].sort((a, b) => a - b);
        const res = await rpc("pyramide_admin_express_set_day", { p_password: state.pw, p_day: day, p_hours: hours });
        if (!res || !res.ok) throw new Error();
        renderExpress();
        toast("Kaydedildi – sitede güncel"); rtPing("site");
      } catch { toast("Kaydedilemedi"); loadExpress(); }
    }, 350);
  }

  $("#expGrid").addEventListener("click", (e) => {
    const c = e.target.closest(".cell");
    const r = e.target.closest("[data-row]");
    if (c) {
      const day = c.dataset.day, h = +c.dataset.hour;
      if (!ex.hours.has(day)) ex.hours.set(day, new Set());
      const set = ex.hours.get(day);
      set.has(h) ? set.delete(h) : set.add(h);
      c.setAttribute("aria-pressed", String(set.has(h)));
      saveDay(day);
    } else if (r) {
      const day = r.dataset.row, now = berlinNow();
      const start = day === now.day ? Math.max(EXP_FROM, now.hour) : EXP_FROM;
      ex.hours.set(day, new Set(r.dataset.act === "all" ? Array.from({ length: EXP_TO - start + 1 }, (_, k) => start + k) : []));
      renderExpress(); saveDay(day);
    }
  });
  $$("[data-quick]").forEach((b) => b.addEventListener("click", async () => {
    const now = berlinNow();
    if (!ex.hours.has(now.day)) ex.hours.set(now.day, new Set());
    const set = ex.hours.get(now.day);
    if (b.dataset.quick === "close") set.clear();
    else for (let h = now.hour; h < Math.min(24, now.hour + +b.dataset.quick); h++) set.add(h);
    if (b.dataset.quick !== "close" && !ex.enabled) await setEnabled(true);
    renderExpress(); saveDay(now.day);
  }));
  async function setEnabled(v) {
    try {
      const res = await rpc("pyramide_admin_express_enable", { p_password: state.pw, p_enabled: v });
      if (!res || !res.ok) throw new Error();
      ex.enabled = v; renderExpress(); toast(v ? "Express açıldı" : "Express kapatıldı"); rtPing("site");
    } catch { toast("Kaydedilemedi"); }
  }
  $("#expSwitch").addEventListener("click", () => setEnabled(!ex.enabled));

  /* ── boot ────────────────────────────────── */
  try { localStorage.setItem("pyr_is_admin", "true"); } catch { /* ignore */ }
  $("#previewBanner").hidden = LIVE_DB;
  if (!LIVE_DB) $("#tabs").hidden = true;
  if (!LIVE_DB) load(true);
  else if (state.pw) load(true);
  else showLogin();
})();
