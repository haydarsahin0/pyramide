/*
 * Pyramide Göttingen — live "please refresh" signal between admin and visitors.
 * Uses a Supabase Realtime broadcast channel. The signal carries no content;
 * every page just re-fetches its own data through the normal checked functions.
 * If Realtime is unavailable, the pages keep polling as before.
 */
(() => {
  "use strict";
  const cfg = window.PYRAMIDE_CONFIG || {};
  const subs = [];
  let channel = null, ready = false;

  const api = {
    on(fn) { subs.push(fn); },
    ping(scope) {
      if (!channel) return;
      try { channel.send({ type: "broadcast", event: "sync", payload: { scope: scope || "all", t: Date.now() } }); } catch { /* ignore */ }
    },
    get connected() { return ready; }
  };
  window.PyrRT = api;

  if (!window.supabase || !cfg.supabaseUrl) return;
  try {
    const client = window.supabase.createClient(cfg.supabaseUrl, cfg.realtimeKey || cfg.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 5 } }
    });
    channel = client.channel("pyramide-sync", { config: { broadcast: { self: false } } });
    channel.on("broadcast", { event: "sync" }, (msg) => {
      const p = (msg && msg.payload) || {};
      subs.forEach((fn) => { try { fn(p); } catch { /* ignore */ } });
    });
    channel.subscribe((status) => { ready = status === "SUBSCRIBED"; });
  } catch { /* realtime is optional */ }
})();
