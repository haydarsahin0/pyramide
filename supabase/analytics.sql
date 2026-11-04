-- Pyramide Göttingen — visitor stats + richer admin data
-- Run after schema.sql and chat.sql. Safe to re-run.
--
-- Each browser gets a random visitor id (no IP, no fingerprint). The site pings
-- every ~30 s while open, so "active now" = seen in the last 90 seconds.

create table if not exists public.pyramide_visitors (
  id          text primary key check (id ~ '^v_[a-z0-9]{16,40}$'),
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  session_started timestamptz not null default now(),
  view        text,
  lang        text,
  device      text,
  referrer    text,
  days        int not null default 1,
  pings       int not null default 0
);
create index if not exists pyramide_visitors_last_seen_idx on public.pyramide_visitors (last_seen desc);

create table if not exists public.pyramide_visitor_days (
  day         date not null,
  visitor_id  text not null references public.pyramide_visitors(id) on delete cascade,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  pings       int not null default 1,
  primary key (day, visitor_id)
);

alter table public.pyramide_visitors enable row level security;
alter table public.pyramide_visitor_days enable row level security;
revoke all on public.pyramide_visitors, public.pyramide_visitor_days from anon, authenticated;

alter table public.pyramide_bookings add column if not exists visitor_id text;
alter table public.pyramide_threads  add column if not exists visitor_id text;
create index if not exists pyramide_bookings_visitor_idx on public.pyramide_bookings (visitor_id);
create index if not exists pyramide_threads_visitor_idx on public.pyramide_threads (visitor_id);

-- ── ping (website) ───────────────────────────────────────────
create or replace function public.pyramide_ping(
  p_visitor text, p_view text default null, p_lang text default null,
  p_device text default null, p_referrer text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_day date := (now() at time zone 'Europe/Berlin')::date;
  v_view text := case when p_view in ('shop', 'order', 'book', 'done') then p_view else 'shop' end;
  v_lang text := case when p_lang in ('de', 'en') then p_lang else null end;
  v_dev  text := case when p_device in ('mobile', 'tablet', 'desktop') then p_device else null end;
  v_ref  text := nullif(left(regexp_replace(coalesce(p_referrer, ''), '[^a-zA-Z0-9.\-]', '', 'g'), 80), '');
  v_new_day boolean;
begin
  if p_visitor is null or p_visitor !~ '^v_[a-z0-9]{16,40}$' then return; end if;

  insert into public.pyramide_visitors (id, view, lang, device, referrer, pings)
  values (p_visitor, v_view, v_lang, v_dev, v_ref, 1)
  on conflict (id) do update set
    session_started = case when pyramide_visitors.last_seen < now() - interval '30 minutes' then now() else pyramide_visitors.session_started end,
    last_seen = now(),
    view = v_view,
    lang = coalesce(v_lang, pyramide_visitors.lang),
    device = coalesce(v_dev, pyramide_visitors.device),
    referrer = coalesce(pyramide_visitors.referrer, v_ref),
    pings = pyramide_visitors.pings + 1
  where pyramide_visitors.last_seen < now() - interval '5 seconds';

  insert into public.pyramide_visitor_days (day, visitor_id)
  values (v_day, p_visitor)
  on conflict (day, visitor_id) do update set last_seen = now(), pings = pyramide_visitor_days.pings + 1
  returning (xmax = 0) into v_new_day;

  if v_new_day and exists (select 1 from public.pyramide_visitor_days where visitor_id = p_visitor and day < v_day) then
    update public.pyramide_visitors set days = days + 1 where id = p_visitor;
  end if;
end;
$$;

-- ── book / chat: same as before, now remembering the visitor id ──
drop function if exists public.pyramide_book(text, timestamptz, text, text, text, int);
create or replace function public.pyramide_book(
  p_order text, p_slot timestamptz, p_name text, p_email text default null, p_lang text default 'de',
  p_qty int default 1, p_visitor text default null
)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_local timestamp := p_slot at time zone 'Europe/Berlin';
  v_name  text := nullif(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), '');
  v_email text := nullif(btrim(coalesce(p_email, '')), '');
  v_vis   text := case when p_visitor ~ '^v_[a-z0-9]{16,40}$' then p_visitor else null end;
  v_rows  int;
begin
  if p_order is null or upper(p_order) !~ '^PYR-[A-HJ-NP-Z2-9]{6}$' then
    return json_build_object('ok', false, 'error', 'invalid_order');
  end if;
  if p_slot < now() + interval '30 minutes'
     or p_slot > now() + interval '30 days'
     or extract(hour from v_local) < 10
     or extract(hour from v_local) > 19
     or extract(minute from v_local) not in (0, 30)
     or extract(second from v_local) <> 0 then
    return json_build_object('ok', false, 'error', 'invalid_slot');
  end if;
  if v_name is null or char_length(v_name) > 80 then
    return json_build_object('ok', false, 'error', 'invalid_name');
  end if;
  if v_email is not null and (char_length(v_email) > 120 or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$') then
    return json_build_object('ok', false, 'error', 'invalid_email');
  end if;
  if p_qty is null or p_qty < 1 or p_qty > 5 then
    return json_build_object('ok', false, 'error', 'invalid_qty');
  end if;

  begin
    insert into public.pyramide_bookings (order_no, slot, name, email, qty, lang, visitor_id)
    values (upper(p_order), p_slot, v_name, v_email, p_qty, case when p_lang in ('de', 'en') then p_lang else 'de' end, v_vis)
    on conflict (order_no) do update
      set slot = excluded.slot, name = excluded.name, email = excluded.email, qty = excluded.qty,
          lang = excluded.lang, visitor_id = coalesce(excluded.visitor_id, pyramide_bookings.visitor_id), updated_at = now()
      where pyramide_bookings.picked_up = false;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      return json_build_object('ok', false, 'error', 'already_picked_up');
    end if;
  exception when unique_violation then
    return json_build_object('ok', false, 'error', 'slot_taken');
  end;
  return json_build_object('ok', true, 'slot', p_slot);
end;
$$;

drop function if exists public.pyramide_chat_send(text, text, text, text, text, text);
create or replace function public.pyramide_chat_send(
  p_token text, p_body text, p_name text default null, p_email text default null,
  p_order text default null, p_lang text default 'de', p_visitor text default null
)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_body  text := btrim(coalesce(p_body, ''));
  v_name  text := nullif(btrim(coalesce(p_name, '')), '');
  v_email text := nullif(btrim(coalesce(p_email, '')), '');
  v_order text := upper(nullif(btrim(coalesce(p_order, '')), ''));
  v_vis   text := case when p_visitor ~ '^v_[a-z0-9]{16,40}$' then p_visitor else null end;
  v_id    uuid;
  v_recent int;
  v_msg   bigint;
begin
  if char_length(coalesce(p_token, '')) < 20 or char_length(p_token) > 128 then
    return json_build_object('ok', false, 'error', 'invalid_token');
  end if;
  if char_length(v_body) < 1 or char_length(v_body) > 2000 then
    return json_build_object('ok', false, 'error', 'invalid_body');
  end if;
  if v_name is not null and char_length(v_name) > 80 then v_name := left(v_name, 80); end if;
  if v_email is not null and (char_length(v_email) > 120 or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$') then
    return json_build_object('ok', false, 'error', 'invalid_email');
  end if;
  if v_order is not null and v_order !~ '^PYR-[A-HJ-NP-Z2-9]{6}$' then v_order := null; end if;

  select id into v_id from public.pyramide_threads where token_hash = public.pyramide_token_hash(p_token);
  if v_id is null then
    if (select count(*) from public.pyramide_threads where created_at > now() - interval '10 minutes') >= 60 then
      return json_build_object('ok', false, 'error', 'rate_limited');
    end if;
    insert into public.pyramide_threads (token_hash, name, email, order_no, lang, visitor_id)
    values (public.pyramide_token_hash(p_token), v_name, v_email, v_order, case when p_lang in ('de', 'en') then p_lang else 'de' end, v_vis)
    returning id into v_id;
  else
    select count(*) into v_recent from public.pyramide_messages
      where thread_id = v_id and sender = 'visitor' and created_at > now() - interval '10 minutes';
    if v_recent >= 15 then
      return json_build_object('ok', false, 'error', 'rate_limited');
    end if;
    update public.pyramide_threads
      set name = coalesce(v_name, name), email = coalesce(v_email, email), order_no = coalesce(v_order, order_no),
          visitor_id = coalesce(v_vis, visitor_id)
      where id = v_id;
  end if;
  insert into public.pyramide_messages (thread_id, sender, body) values (v_id, 'visitor', v_body) returning id into v_msg;
  update public.pyramide_threads set admin_unread = admin_unread + 1, last_message_at = now() where id = v_id;
  return json_build_object('ok', true, 'id', v_msg);
end;
$$;

-- ── admin: overview stats ────────────────────────────────────
create or replace function public.pyramide_admin_stats(p_password text)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Europe/Berlin')::date;
begin
  if not public.pyramide_admin_ok(p_password) then
    return json_build_object('ok', false, 'error', 'unauthorized');
  end if;
  return json_build_object(
    'ok', true,
    'now', now(),
    'active_now', (select count(*) from pyramide_visitors where last_seen > now() - interval '90 seconds'),
    'active', coalesce((
      select json_agg(json_build_object(
        'id', right(v.id, 6), 'view', v.view, 'lang', v.lang, 'device', v.device, 'referrer', v.referrer,
        'session_started', v.session_started, 'last_seen', v.last_seen, 'days', v.days,
        'returning', v.first_seen < now() - interval '1 day',
        'booking', (select json_build_object('order_no', b.order_no, 'qty', b.qty, 'slot', b.slot)
                    from pyramide_bookings b where b.visitor_id = v.id order by b.created_at desc limit 1),
        'chat', exists (select 1 from pyramide_threads t where t.visitor_id = v.id)
      ) order by v.session_started)
      from pyramide_visitors v where v.last_seen > now() - interval '90 seconds'
    ), '[]'::json),
    'today', (select count(*) from pyramide_visitor_days where day = v_today),
    'yesterday', (select count(*) from pyramide_visitor_days where day = v_today - 1),
    'last7', (select count(distinct visitor_id) from pyramide_visitor_days where day > v_today - 7),
    'last30', (select count(distinct visitor_id) from pyramide_visitor_days where day > v_today - 30),
    'new_today', (select count(*) from pyramide_visitors where (first_seen at time zone 'Europe/Berlin')::date = v_today),
    'bookings_today', (select count(*) from pyramide_bookings where (created_at at time zone 'Europe/Berlin')::date = v_today),
    'bookings7', (select count(*) from pyramide_bookings where created_at > now() - interval '7 days'),
    'booked_visitors7', (select count(distinct visitor_id) from pyramide_bookings where visitor_id is not null and created_at > now() - interval '7 days'),
    'chats_today', (select count(distinct thread_id) from pyramide_messages where sender = 'visitor' and (created_at at time zone 'Europe/Berlin')::date = v_today),
    'daily', (
      select json_agg(json_build_object(
        'day', d::date,
        'visitors', (select count(*) from pyramide_visitor_days vd where vd.day = d::date),
        'bookings', (select count(*) from pyramide_bookings b where (b.created_at at time zone 'Europe/Berlin')::date = d::date)
      ) order by d)
      from generate_series(v_today - 13, v_today, interval '1 day') d
    ),
    'hours_today', (
      select json_agg(json_build_object('hour', h, 'visitors',
        (select count(*) from pyramide_visitor_days vd where vd.day = v_today
           and extract(hour from vd.first_seen at time zone 'Europe/Berlin') <= h
           and extract(hour from vd.last_seen at time zone 'Europe/Berlin') >= h)) order by h)
      from generate_series(0, 23) h
    ),
    'devices', coalesce((
      select json_agg(json_build_object('key', k, 'n', n) order by n desc) from (
        select coalesce(v.device, 'unknown') k, count(*) n from pyramide_visitors v
        where v.last_seen > now() - interval '30 days' group by 1) s
    ), '[]'::json),
    'langs', coalesce((
      select json_agg(json_build_object('key', k, 'n', n) order by n desc) from (
        select coalesce(v.lang, 'unknown') k, count(*) n from pyramide_visitors v
        where v.last_seen > now() - interval '30 days' group by 1) s
    ), '[]'::json),
    'referrers', coalesce((
      select json_agg(json_build_object('key', k, 'n', n) order by n desc) from (
        select coalesce(v.referrer, 'direct') k, count(*) n from pyramide_visitors v
        where v.last_seen > now() - interval '30 days' group by 1 order by 2 desc limit 8) s
    ), '[]'::json)
  );
end;
$$;

-- ── admin: threads and thread with customer context ─────────
create or replace function public.pyramide_admin_threads(p_password text)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if not public.pyramide_admin_ok(p_password) then
    return json_build_object('ok', false, 'error', 'unauthorized');
  end if;
  return json_build_object('ok', true, 'rows', coalesce((
    select json_agg(json_build_object(
      'id', t.id, 'name', t.name, 'email', t.email, 'order_no', t.order_no, 'lang', t.lang,
      'unread', t.admin_unread, 'created_at', t.created_at, 'last_message_at', t.last_message_at,
      'online', exists (select 1 from pyramide_visitors v where v.id = t.visitor_id and v.last_seen > now() - interval '90 seconds'),
      'booking', (select json_build_object('order_no', b.order_no, 'qty', b.qty, 'slot', b.slot, 'picked_up', b.picked_up)
                  from pyramide_bookings b
                  where b.order_no = t.order_no or (t.visitor_id is not null and b.visitor_id = t.visitor_id)
                  order by b.created_at desc limit 1),
      'last', (select json_build_object('sender', m.sender, 'body', left(m.body, 160))
               from pyramide_messages m where m.thread_id = t.id order by m.id desc limit 1)
    ) order by t.last_message_at desc)
    from pyramide_threads t
  ), '[]'::json));
end;
$$;

create or replace function public.pyramide_admin_thread(p_password text, p_thread uuid)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare t record;
begin
  if not public.pyramide_admin_ok(p_password) then
    return json_build_object('ok', false, 'error', 'unauthorized');
  end if;
  select * into t from pyramide_threads where id = p_thread;
  update pyramide_threads set admin_unread = 0 where id = p_thread;
  return json_build_object(
    'ok', true,
    'rows', coalesce((
      select json_agg(json_build_object('id', m.id, 'sender', m.sender, 'body', m.body, 'created_at', m.created_at) order by m.id)
      from pyramide_messages m where m.thread_id = p_thread
    ), '[]'::json),
    'bookings', coalesce((
      select json_agg(json_build_object(
        'order_no', b.order_no, 'slot', b.slot, 'qty', b.qty, 'name', b.name, 'email', b.email,
        'picked_up', b.picked_up, 'created_at', b.created_at, 'updated_at', b.updated_at
      ) order by b.created_at desc)
      from pyramide_bookings b
      where b.order_no = t.order_no or (t.visitor_id is not null and b.visitor_id = t.visitor_id)
    ), '[]'::json),
    'visitor', (
      select json_build_object(
        'first_seen', v.first_seen, 'last_seen', v.last_seen, 'days', v.days, 'device', v.device,
        'lang', v.lang, 'referrer', v.referrer, 'view', v.view,
        'online', v.last_seen > now() - interval '90 seconds')
      from pyramide_visitors v where v.id = t.visitor_id
    )
  );
end;
$$;

-- reservations list now also says when it was made and whether that visitor is online
create or replace function public.pyramide_admin_list(p_password text)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if not public.pyramide_admin_ok(p_password) then
    return json_build_object('ok', false, 'error', 'unauthorized');
  end if;
  return json_build_object('ok', true, 'rows', coalesce((
    select json_agg(json_build_object(
      'order_no', b.order_no, 'slot', b.slot, 'name', b.name, 'email', b.email,
      'qty', b.qty, 'lang', b.lang, 'picked_up', b.picked_up, 'created_at', b.created_at, 'updated_at', b.updated_at,
      'online', exists (select 1 from pyramide_visitors v where v.id = b.visitor_id and v.last_seen > now() - interval '90 seconds'),
      'has_chat', exists (select 1 from pyramide_threads t where t.order_no = b.order_no or (b.visitor_id is not null and t.visitor_id = b.visitor_id))
    ) order by b.slot)
    from pyramide_bookings b
  ), '[]'::json));
end;
$$;

-- ── permissions ──────────────────────────────────────────────
revoke all on function public.pyramide_ping(text, text, text, text, text) from public;
revoke all on function public.pyramide_book(text, timestamptz, text, text, text, int, text) from public;
revoke all on function public.pyramide_chat_send(text, text, text, text, text, text, text) from public;
revoke all on function public.pyramide_admin_stats(text) from public;
revoke all on function public.pyramide_admin_threads(text) from public;
revoke all on function public.pyramide_admin_thread(text, uuid) from public;
revoke all on function public.pyramide_admin_list(text) from public;

grant execute on function public.pyramide_ping(text, text, text, text, text) to anon, authenticated;
grant execute on function public.pyramide_book(text, timestamptz, text, text, text, int, text) to anon, authenticated;
grant execute on function public.pyramide_chat_send(text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.pyramide_admin_stats(text) to anon, authenticated;
grant execute on function public.pyramide_admin_threads(text) to anon, authenticated;
grant execute on function public.pyramide_admin_thread(text, uuid) to anon, authenticated;
grant execute on function public.pyramide_admin_list(text) to anon, authenticated;

-- forget visitors who have not come back for 90 days (run any time)
create or replace function public.pyramide_cleanup_visitors()
returns void language sql security definer set search_path = public as $$
  delete from pyramide_visitors where last_seen < now() - interval '90 days';
$$;
revoke all on function public.pyramide_cleanup_visitors() from public, anon, authenticated;
