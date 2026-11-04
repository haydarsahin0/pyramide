-- Pyramide Göttingen — admin notices to waiting customers (e.g. LSG room number)
-- Run after express_now.sql. Safe to re-run.
--
-- A notice belongs to an order number. The customer's browser knows its order
-- numbers and shows the notices in the chat and on the reservation card.

create table if not exists public.pyramide_broadcasts (
  id          bigint generated always as identity primary key,
  body        text not null check (char_length(body) between 1 and 1000),
  audience    text not null,
  recipients  int  not null default 0,
  created_at  timestamptz not null default now()
);
create table if not exists public.pyramide_notices (
  id           bigint generated always as identity primary key,
  order_no     text not null,
  broadcast_id bigint references public.pyramide_broadcasts(id) on delete cascade,
  body         text not null check (char_length(body) between 1 and 1000),
  created_at   timestamptz not null default now(),
  seen_at      timestamptz
);
create index if not exists pyramide_notices_order_idx on public.pyramide_notices (order_no, id);

alter table public.pyramide_broadcasts enable row level security;
alter table public.pyramide_notices enable row level security;
revoke all on public.pyramide_broadcasts, public.pyramide_notices from anon, authenticated;

-- which reservations are still waiting
create or replace function public.pyramide_waiting(p_audience text)
returns setof public.pyramide_bookings
language sql
stable
security definer
set search_path = public
as $$
  select b.* from pyramide_bookings b
  where not b.picked_up
    and (case when b.express then b.slot + interval '60 minutes' else b.slot + interval '30 minutes' end) > now()
    and case p_audience
          when 'today'   then (b.slot at time zone 'Europe/Berlin')::date = (now() at time zone 'Europe/Berlin')::date
          when 'express' then b.express
          else true
        end;
$$;
revoke all on function public.pyramide_waiting(text) from public, anon, authenticated;

-- ── customer ─────────────────────────────────────────────────
create or replace function public.pyramide_notices_fetch(p_orders text[], p_after bigint default 0)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(json_agg(json_build_object('id', n.id, 'order_no', n.order_no, 'body', n.body, 'created_at', n.created_at) order by n.id), '[]'::json)
  from pyramide_notices n
  where n.order_no = any (
          select upper(o) from unnest(coalesce(p_orders, '{}')) o
          where upper(o) ~ '^PYR-[A-HJ-NP-Z2-9]{6}$' limit 10)
    and n.id > coalesce(p_after, 0);
$$;

create or replace function public.pyramide_notices_seen(p_orders text[], p_upto bigint)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  update pyramide_notices set seen_at = now()
  where seen_at is null and id <= coalesce(p_upto, 0)
    and order_no = any (
          select upper(o) from unnest(coalesce(p_orders, '{}')) o
          where upper(o) ~ '^PYR-[A-HJ-NP-Z2-9]{6}$' limit 10);
$$;

-- ── admin ────────────────────────────────────────────────────
create or replace function public.pyramide_admin_broadcast(p_password text, p_body text, p_audience text default 'upcoming')
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_body text := btrim(coalesce(p_body, '')); v_id bigint; v_n int;
begin
  if not public.pyramide_admin_ok(p_password) then
    return json_build_object('ok', false, 'error', 'unauthorized');
  end if;
  if char_length(v_body) < 1 or char_length(v_body) > 1000 then
    return json_build_object('ok', false, 'error', 'invalid_body');
  end if;
  if p_audience not in ('today', 'upcoming', 'express') then p_audience := 'upcoming'; end if;
  select count(*) into v_n from public.pyramide_waiting(p_audience);
  if v_n = 0 then
    return json_build_object('ok', false, 'error', 'no_recipients');
  end if;
  insert into pyramide_broadcasts (body, audience, recipients) values (v_body, p_audience, v_n) returning id into v_id;
  insert into pyramide_notices (order_no, broadcast_id, body)
  select w.order_no, v_id, v_body from public.pyramide_waiting(p_audience) w;
  return json_build_object('ok', true, 'id', v_id, 'recipients', v_n);
end;
$$;

create or replace function public.pyramide_admin_notify(p_password text, p_order text, p_body text)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_body text := btrim(coalesce(p_body, '')); v_id bigint;
begin
  if not public.pyramide_admin_ok(p_password) then
    return json_build_object('ok', false, 'error', 'unauthorized');
  end if;
  if char_length(v_body) < 1 or char_length(v_body) > 1000 then
    return json_build_object('ok', false, 'error', 'invalid_body');
  end if;
  if not exists (select 1 from pyramide_bookings where order_no = upper(p_order)) then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  insert into pyramide_broadcasts (body, audience, recipients) values (v_body, 'single:' || upper(p_order), 1) returning id into v_id;
  insert into pyramide_notices (order_no, broadcast_id, body) values (upper(p_order), v_id, v_body);
  return json_build_object('ok', true, 'id', v_id, 'recipients', 1);
end;
$$;

create or replace function public.pyramide_admin_broadcasts(p_password text)
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
      'id', b.id, 'body', b.body, 'audience', b.audience, 'recipients', b.recipients, 'created_at', b.created_at,
      'seen', (select count(*) from pyramide_notices n where n.broadcast_id = b.id and n.seen_at is not null),
      'names', (select json_agg(k.name order by k.slot) from pyramide_notices n join pyramide_bookings k on k.order_no = n.order_no where n.broadcast_id = b.id)
    ) order by b.id desc)
    from (select * from pyramide_broadcasts order by id desc limit 20) b
  ), '[]'::json));
end;
$$;

-- notices of given orders, for the chat view in admin
create or replace function public.pyramide_admin_order_notices(p_password text, p_orders text[])
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
    select json_agg(json_build_object('id', n.id, 'order_no', n.order_no, 'body', n.body, 'created_at', n.created_at, 'seen_at', n.seen_at) order by n.id)
    from pyramide_notices n where n.order_no = any (select upper(o) from unnest(coalesce(p_orders, '{}')) o)
  ), '[]'::json));
end;
$$;

revoke all on function public.pyramide_notices_fetch(text[], bigint) from public;
revoke all on function public.pyramide_notices_seen(text[], bigint) from public;
revoke all on function public.pyramide_admin_broadcast(text, text, text) from public;
revoke all on function public.pyramide_admin_notify(text, text, text) from public;
revoke all on function public.pyramide_admin_broadcasts(text) from public;
revoke all on function public.pyramide_admin_order_notices(text, text[]) from public;
grant execute on function public.pyramide_notices_fetch(text[], bigint) to anon, authenticated;
grant execute on function public.pyramide_notices_seen(text[], bigint) to anon, authenticated;
grant execute on function public.pyramide_admin_broadcast(text, text, text) to anon, authenticated;
grant execute on function public.pyramide_admin_notify(text, text, text) to anon, authenticated;
grant execute on function public.pyramide_admin_broadcasts(text) to anon, authenticated;
grant execute on function public.pyramide_admin_order_notices(text, text[]) to anon, authenticated;
