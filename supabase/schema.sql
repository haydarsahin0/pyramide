-- Pyramide Göttingen — pickup bookings
-- Run once in Supabase → SQL Editor. Safe to re-run.
--
-- The website never reads this table directly. Visitors can only:
--   • see which slot times are taken (no names/emails),
--   • book or move the slot for an order number they know.
-- You see everything in Table Editor → pyramide_bookings.

create table if not exists public.pyramide_bookings (
  id          bigint generated always as identity primary key,
  order_no    text        not null unique check (order_no ~ '^PYR-[A-HJ-NP-Z2-9]{6}$'),
  slot        timestamptz not null unique,
  name        text        not null check (char_length(name) between 1 and 80),
  email       text        check (email is null or (char_length(email) <= 120 and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$')),
  lang        text        check (lang in ('de', 'en')),
  picked_up   boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists pyramide_bookings_slot_idx on public.pyramide_bookings (slot);

alter table public.pyramide_bookings enable row level security;
revoke all on public.pyramide_bookings from anon, authenticated;

-- Readable view for you (Berlin time), not exposed to visitors
create or replace view public.pyramide_bookings_berlin
with (security_invoker = true) as
  select order_no,
         to_char(slot at time zone 'Europe/Berlin', 'YYYY-MM-DD') as day,
         to_char(slot at time zone 'Europe/Berlin', 'HH24:MI')    as time,
         name, email, lang, picked_up, created_at
  from public.pyramide_bookings
  order by slot;
revoke all on public.pyramide_bookings_berlin from anon, authenticated;

-- Taken slot times in a range (excluding the caller's own order)
create or replace function public.pyramide_taken_slots(p_from timestamptz, p_to timestamptz, p_order text default null)
returns table (slot timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select b.slot
  from public.pyramide_bookings b
  where b.slot between p_from and least(p_to, p_from + interval '40 days')
    and (p_order is null or b.order_no <> p_order);
$$;

-- Existing booking for an order number
create or replace function public.pyramide_get_booking(p_order text)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object('slot', b.slot)
  from public.pyramide_bookings b
  where b.order_no = upper(p_order) and b.slot > now();
$$;

-- Book (or move) the slot for an order
create or replace function public.pyramide_book(
  p_order text, p_slot timestamptz, p_name text, p_email text default null, p_lang text default 'de'
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
  v_rows  int;
begin
  if p_order is null or upper(p_order) !~ '^PYR-[A-HJ-NP-Z2-9]{6}$' then
    return json_build_object('ok', false, 'error', 'invalid_order');
  end if;

  -- 10:00–19:30, every 30 minutes, at least 30 min ahead, at most 30 days ahead
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

  begin
    insert into public.pyramide_bookings (order_no, slot, name, email, lang)
    values (upper(p_order), p_slot, v_name, v_email, case when p_lang in ('de', 'en') then p_lang else 'de' end)
    on conflict (order_no) do update
      set slot = excluded.slot, name = excluded.name, email = excluded.email,
          lang = excluded.lang, updated_at = now()
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

revoke all on function public.pyramide_taken_slots(timestamptz, timestamptz, text) from public;
revoke all on function public.pyramide_get_booking(text) from public;
revoke all on function public.pyramide_book(text, timestamptz, text, text, text) from public;
grant execute on function public.pyramide_taken_slots(timestamptz, timestamptz, text) to anon, authenticated;
grant execute on function public.pyramide_get_booking(text) to anon, authenticated;
grant execute on function public.pyramide_book(text, timestamptz, text, text, text) to anon, authenticated;
