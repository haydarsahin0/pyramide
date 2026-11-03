-- Pyramide Göttingen — pickup reservations + admin
-- Run once in Supabase → SQL Editor. Safe to re-run.
--
-- Visitors never read this table directly. They can only:
--   • see which slot times are taken (no names/emails),
--   • reserve or move the slot for an order number they know.
-- The admin page (admin.html) reads everything after checking your password.
--
-- AFTER running this file, set your admin password once (SQL Editor):
--   select public.pyramide_admin_set_password('your-long-password');

create extension if not exists pgcrypto with schema extensions;

-- ── reservations ─────────────────────────────────────────────
create table if not exists public.pyramide_bookings (
  id          bigint generated always as identity primary key,
  order_no    text        not null unique check (order_no ~ '^PYR-[A-HJ-NP-Z2-9]{6}$'),
  slot        timestamptz not null unique,
  name        text        not null check (char_length(name) between 1 and 80),
  email       text        check (email is null or (char_length(email) <= 120 and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$')),
  qty         smallint    not null default 1 check (qty between 1 and 5),
  lang        text        check (lang in ('de', 'en')),
  picked_up   boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.pyramide_bookings add column if not exists qty smallint not null default 1 check (qty between 1 and 5);

create index if not exists pyramide_bookings_slot_idx on public.pyramide_bookings (slot);
alter table public.pyramide_bookings enable row level security;
revoke all on public.pyramide_bookings from anon, authenticated;

-- ── admin password (single row, bcrypt hash) ────────────────
create table if not exists public.pyramide_admin (
  id            int primary key default 1 check (id = 1),
  password_hash text not null
);
alter table public.pyramide_admin enable row level security;
revoke all on public.pyramide_admin from anon, authenticated;

create or replace function public.pyramide_admin_set_password(p_password text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if char_length(coalesce(p_password, '')) < 10 then
    raise exception 'Password must be at least 10 characters';
  end if;
  insert into public.pyramide_admin (id, password_hash)
  values (1, crypt(p_password, gen_salt('bf', 10)))
  on conflict (id) do update set password_hash = excluded.password_hash;
end;
$$;
revoke all on function public.pyramide_admin_set_password(text) from public, anon, authenticated;

create or replace function public.pyramide_admin_ok(p_password text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare ok boolean;
begin
  select exists (select 1 from public.pyramide_admin a where a.password_hash = crypt(coalesce(p_password, ''), a.password_hash)) into ok;
  if not ok then perform pg_sleep(1); end if;  -- slow down guessing
  return ok;
end;
$$;
revoke all on function public.pyramide_admin_ok(text) from public, anon, authenticated;

-- ── public functions (website) ───────────────────────────────
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

create or replace function public.pyramide_get_booking(p_order text)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object('slot', b.slot, 'qty', b.qty)
  from public.pyramide_bookings b
  where b.order_no = upper(p_order) and b.slot > now();
$$;

drop function if exists public.pyramide_book(text, timestamptz, text, text, text);

create or replace function public.pyramide_book(
  p_order text, p_slot timestamptz, p_name text, p_email text default null, p_lang text default 'de', p_qty int default 1
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
  if p_qty is null or p_qty < 1 or p_qty > 5 then
    return json_build_object('ok', false, 'error', 'invalid_qty');
  end if;

  begin
    insert into public.pyramide_bookings (order_no, slot, name, email, qty, lang)
    values (upper(p_order), p_slot, v_name, v_email, p_qty, case when p_lang in ('de', 'en') then p_lang else 'de' end)
    on conflict (order_no) do update
      set slot = excluded.slot, name = excluded.name, email = excluded.email,
          qty = excluded.qty, lang = excluded.lang, updated_at = now()
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

-- ── admin functions (admin.html) ─────────────────────────────
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
      'qty', b.qty, 'lang', b.lang, 'picked_up', b.picked_up, 'created_at', b.created_at
    ) order by b.slot)
    from public.pyramide_bookings b
  ), '[]'::json));
end;
$$;

create or replace function public.pyramide_admin_set_picked(p_password text, p_order text, p_value boolean)
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
  update public.pyramide_bookings set picked_up = p_value, updated_at = now() where order_no = upper(p_order);
  return json_build_object('ok', found);
end;
$$;

create or replace function public.pyramide_admin_delete(p_password text, p_order text)
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
  delete from public.pyramide_bookings where order_no = upper(p_order);
  return json_build_object('ok', found);
end;
$$;

-- ── permissions ──────────────────────────────────────────────
revoke all on function public.pyramide_taken_slots(timestamptz, timestamptz, text) from public;
revoke all on function public.pyramide_get_booking(text) from public;
revoke all on function public.pyramide_book(text, timestamptz, text, text, text, int) from public;
revoke all on function public.pyramide_admin_list(text) from public;
revoke all on function public.pyramide_admin_set_picked(text, text, boolean) from public;
revoke all on function public.pyramide_admin_delete(text, text) from public;

grant execute on function public.pyramide_taken_slots(timestamptz, timestamptz, text) to anon, authenticated;
grant execute on function public.pyramide_get_booking(text) to anon, authenticated;
grant execute on function public.pyramide_book(text, timestamptz, text, text, text, int) to anon, authenticated;
grant execute on function public.pyramide_admin_list(text) to anon, authenticated;
grant execute on function public.pyramide_admin_set_picked(text, text, boolean) to anon, authenticated;
grant execute on function public.pyramide_admin_delete(text, text) to anon, authenticated;

-- old helper view from the first version (no longer needed)
drop view if exists public.pyramide_bookings_berlin;
