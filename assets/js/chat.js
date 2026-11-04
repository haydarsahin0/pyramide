(() => {
  "use strict";

  const cfg = window.PYRAMIDE_CONFIG;
  const dict = window.PYRAMIDE_I18N;
  if (!(cfg.supabaseUrl && cfg.supabaseAnonKey)) return; // chat needs the database

  const $ = (s) => document.querySelector(s);
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem("pyr_" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("pyr_" + k, JSON.stringify(v)); } catch { /* ignore */ } }
  };
  const lang = () => (document.documentElement.lang === "en" ? "en" : "de");
  const t = (k) => (dict[lang()] && dict[lang()][k]) || dict.de[k] || k;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function rpc(fn, body) {
    const headers = { apikey: cfg.supabaseAnonKey, "Content-Type": "application/json" };
    if (cfg.supabaseAnonKey.startsWith("eyJ")) headers.Authorization = "Bearer " + cfg.supabaseAnonKey;
    const r = await fetch(`${cfg.supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error("rpc " + r.status);
    return r.json();
  }

  const fab = $("#chatFab"), panel = $("#chatPanel"), body = $("#chatBody"), form = $("#chatForm"),
        input = $("#chatInput"), badge = $("#chatBadge"), err = $("#chatErr");
  fab.hidden = false;

  let token = store.get("chat_token");
  let msgs = store.get("chat_msgs", []);           // cached thread
  let lastId = msgs.reduce((m, x) => Math.max(m, x.id || 0), 0);
  let open = false, timer = null, sending = false;

  const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  function newToken() {
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    const c = Array.from(b, (x) => ALPHA[x % 32]).join("");
    return "PYC-" + c.match(/.{4}/g).join("-");
  }
  function normalizeCode(raw) {
    let c = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (c.startsWith("PYC")) c = c.slice(3);
    if (c.length !== 16 || /[^A-HJ-NP-Z2-9]/.test(c)) return null;
    return "PYC-" + c.match(/.{4}/g).join("-");
  }
  const profile = () => store.get("profile") || {};

  const fmtTime = (iso) => {
    const d = new Date(iso);
    const sameDay = new Date().toDateString() === d.toDateString();
    return new Intl.DateTimeFormat(lang() === "de" ? "de-DE" : "en-GB",
      sameDay ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(d);
  };

  function render() {
    let html = `<div class="bubble from-admin"><p>${esc(t("chat.hello"))}</p></div>`;
    for (const m of msgs) {
      html += `<div class="bubble ${m.sender === "admin" ? "from-admin" : "from-me"}${m.pending ? " pending" : ""}${m.failed ? " failed" : ""}">
        <p>${esc(m.body).replace(/\n/g, "<br>")}</p>
        <span class="bubble-meta">${m.failed ? esc(t("chat.failed")) : m.pending ? "…" : esc(fmtTime(m.created_at))}</span>
      </div>`;
    }
    body.innerHTML = html;
    body.scrollTop = body.scrollHeight;
    $("#chatIdentity").hidden = msgs.some((m) => m.sender === "visitor" && !m.failed);
    updateBadge();
  }

  const baseTitle = () => document.title.replace(/^\(\d+\)\s*/, "");
  function updateBadge() {
    const seen = store.get("chat_seen", 0);
    const fresh = msgs.filter((m) => m.sender === "admin" && m.id > seen);
    const unread = open ? 0 : fresh.length;
    badge.hidden = !unread;
    badge.textContent = unread;
    fab.classList.toggle("has-unread", !!unread);
    const label = fab.querySelector(".chat-fab-label");
    label.textContent = t(unread ? "chat.fab.new" : "chat.fab");
    document.title = (unread ? `(${unread}) ` : "") + baseTitle();

    // speech bubble with the latest reply, until opened or dismissed
    const peek = $("#chatPeek");
    const last = fresh[fresh.length - 1];
    const dismissed = store.get("chat_peek_dismissed", 0);
    if (unread && last && last.id > dismissed) {
      $("#chatPeekBody").textContent = last.body.length > 110 ? last.body.slice(0, 110) + "…" : last.body;
      peek.hidden = false;
    } else {
      peek.hidden = true;
    }
  }

  async function poll() {
    if (!token) return;
    try {
      const rows = await rpc("pyramide_chat_fetch", { p_token: token, p_after: lastId });
      if (Array.isArray(rows) && rows.length) {
        msgs = msgs.filter((m) => !m.pending || m.failed);
        for (const r of rows) if (!msgs.some((m) => m.id === r.id)) msgs.push(r);
        msgs.sort((a, b) => (a.id || 1e15) - (b.id || 1e15));
        lastId = Math.max(lastId, ...rows.map((r) => r.id));
        store.set("chat_msgs", msgs.filter((m) => m.id));
        if (open) store.set("chat_seen", lastId);
        render();
      }
    } catch { /* try again next tick */ }
  }

  function schedule() {
    clearInterval(timer);
    if (!token) return;
    timer = setInterval(() => { if (!document.hidden) poll(); }, open ? 6000 : 20000);
  }

  function setOpen(v) {
    open = v;
    panel.hidden = !v;
    fab.setAttribute("aria-expanded", String(v));
    document.body.classList.toggle("chat-open", v);
    if (v) {
      const prof = profile();
      if (!$("#chatName").value && prof.name) $("#chatName").value = prof.name;
      if (!$("#chatEmail").value && prof.email) $("#chatEmail").value = prof.email;
      store.set("chat_seen", lastId);
      render();
      poll();
      setTimeout(() => input.focus(), 60);
    }
    updateBadge();
    schedule();
  }

  fab.addEventListener("click", () => setOpen(!open));
  $("#chatPeekOpen").addEventListener("click", () => setOpen(true));
  $("#chatPeekClose").addEventListener("click", () => {
    const lastAdmin = msgs.filter((m) => m.sender === "admin").pop();
    if (lastAdmin) store.set("chat_peek_dismissed", lastAdmin.id);
    $("#chatPeek").hidden = true;
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && token) poll(); });
  $("#chatClose").addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && open) setOpen(false); });

  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || sending) return;
    const email = $("#chatEmail").value.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { err.textContent = t("chat.err.email"); err.hidden = false; return; }
    err.hidden = true;
    if (!token) { token = newToken(); store.set("chat_token", token); }
    const order = (store.get("current") || {}).no || null;
    const temp = { sender: "visitor", body: text, pending: true, created_at: new Date().toISOString() };
    msgs.push(temp); render();
    input.value = ""; input.style.height = "auto";
    sending = true;
    try {
      const res = await rpc("pyramide_chat_send", {
        p_token: token, p_body: text, p_name: $("#chatName").value.trim() || null,
        p_email: email || null, p_order: order, p_lang: lang(), p_visitor: store.get("vid")
      });
      if (!res || !res.ok) throw new Error(res && res.error);
      const prof = profile(), nm = $("#chatName").value.trim();
      store.set("profile", { name: nm || prof.name || "", email: email || prof.email || "" });
      renderCode();
      await poll();
    } catch (ex) {
      temp.pending = false; temp.failed = true;
      err.textContent = ex.message === "rate_limited" ? t("chat.err.rate") : t("chat.err.network");
      err.hidden = false;
      render();
    } finally {
      sending = false;
      schedule();
    }
  });

  /* chat code: continue on another device */
  function renderCode() {
    $("#chatCodeHave").hidden = !token;
    $("#chatCodeNone").hidden = !!token;
    if (token) $("#chatCodeVal").textContent = token;
  }
  $("#chatCodeBtn").addEventListener("click", () => {
    const box = $("#chatCode"); box.hidden = !box.hidden;
    $("#chatCodeBtn").setAttribute("aria-expanded", String(!box.hidden));
    $("#chatRestoreErr").hidden = true;
    renderCode();
  });
  $("#chatCodeCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(token); } catch { /* ignore */ }
    const tEl = document.getElementById("toast");
    if (tEl) { tEl.textContent = t("chat.code.copied"); tEl.classList.add("show"); setTimeout(() => tEl.classList.remove("show"), 2000); }
  });
  $("#chatRestore").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = normalizeCode($("#chatRestoreInput").value);
    const errEl = $("#chatRestoreErr");
    if (!code) { errEl.hidden = false; return; }
    try {
      const rows = await rpc("pyramide_chat_fetch", { p_token: code, p_after: 0 });
      if (!Array.isArray(rows) || !rows.length) { errEl.hidden = false; return; }
      token = code; store.set("chat_token", token);
      msgs = rows; lastId = Math.max(...rows.map((r) => r.id));
      store.set("chat_msgs", msgs); store.set("chat_seen", lastId);
      errEl.hidden = true; $("#chatRestoreInput").value = ""; $("#chatCode").hidden = true;
      renderCode(); render(); schedule();
    } catch { errEl.hidden = false; }
  });
  renderCode();

  // keep texts in sync with the language switch
  new MutationObserver(() => { updateBadge(); if (open) render(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });

  updateBadge();
  if (token) { poll(); schedule(); }
})();
