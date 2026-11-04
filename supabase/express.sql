-- Pyramide Göttingen — Express pickup (+3 €, customer picks the time)
-- Run after analytics.sql. Safe to re-run.
--
-- You mark the hours you are available in admin.html → Express.
-- Customers can then pick any quarter hour inside those hours.

create table if not exists public.pyramide_express_hours (
  day  date not null,
  hour smallint not null check (hour between 0 and 23),
  primary key (day, hour)
);
create table if not exists public.pyramide_settings (
  key   text primary key,
  value jsonb not null
);
insert into public.pyramide_settings (key, value) values ('express_enabled', 'true'::jsonb) on conflict (key) do nothing;

alter table public.pyramide_express_hours enable row level security;
alter table public.pyramide_settings enable row level security;
revoke all on public.pyramide_express_hours, public.pyramide_settings from anon, authenticated;

alter table public.pyramide_bookings add column if not exists express boolean not null default false;

create or replace function public.pyramide_express_on()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select (value)::text::boolean from pyramide_settings where key = 'express_enabled'), false);
$$;
revoke all on function public.pyramide_express_on() from public, anon, authenticated;

-- public: available express hours (Berlin dates/hours)
create or replace function public.pyramide_express_hours(p_from date default null, p_to date default null)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'enabled', public.pyramide_express_on(),
    'hours', case when public.pyramide_express_on() then coalesce((
      select json_agg(json_build_object('day', e.day, 'hour', e.hour) order by e.day, e.hour)
      from pyramide_express_hours e
      where e.day >= coalesce(p_from, (now() at time zone 'Europe/Berlin')::date)
        and e.day <= least(coalesce(p_to, (now() at time zone 'Europe/Berlin')::date + 30), (now() at time zone 'Europe/Berlin')::date + 30)
    ), '[]'::json) else '[]'::json end
  );
$$;

-- booking now knows Express
drop function if exists public.pyramide_book(text, timestamptz, text, text, text, int, text);
create or replace function public.pyramide_book(
  p_order text, p_slot timestamptz, p_name text, p_email text default null, p_lang text default 'de',
  p_qty int default 1, p_visitor text default null, p_express boolean default false
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
  v_exp   boolean := coalesce(p_express, false);
  v_rows  int;
begin
  if p_order is null or upper(p_order) !~ '^PYR-[A-HJ-NP-Z2-9]{6}$' then
    return json_build_object('ok', false, 'error', 'invalid_order');
  end if;

  if v_exp then
    -- any quarter hour inside an hour you opened, at least 15 min ahead
    if not public.pyramide_express_on()
       or p_slot < now() + interval '15 minutes'
       or p_slot > now() + interval '30 days'
       or extract(minute from v_local) not in (0, 15, 30, 45)
       or extract(second from v_local) <> 0
       or not exists (select 1 from pyramide_express_hours e
                      where e.day = v_local::date and e.hour = extract(hour from v_local)) then
      return json_build_object('ok', false, 'error', 'invalid_slot');
    end if;
  else
    if p_slot < now() + interval '30 minutes'
       or p_slot > now() + interval '30 days'
       or extract(hour from v_local) < 10
       or extract(hour from v_local) > 19
       or extract(minute from v_local) not in (0, 30)
       or extract(second from v_local) <> 0 then
      return json_build_object('ok', false, 'error', 'invalid_slot');
    end if;
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
    insert into public.pyramide_bookings (order_no, slot, name, email, qty, lang, visitor_id, express)
    values (upper(p_order), p_slot, v_name, v_email, p_qty, case when p_lang in ('de', 'en') then p_lang else 'de' end, v_vis, v_exp)
    on conflict (order_no) do update
      set slot = excluded.slot, name = excluded.name, email = excluded.email, qty = excluded.qty,
          lang = excluded.lang, visitor_id = coalesce(excluded.visitor_id, pyramide_bookings.visitor_id),
          express = excluded.express, updated_at = now()
      where pyramide_bookings.picked_up = false;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      return json_build_object('ok', false, 'error', 'already_picked_up');
    end if;
  exception when unique_violation then
    return json_build_object('ok', false, 'error', 'slot_taken');
  end;
  return json_build_object('ok', true, 'slot', p_slot, 'express', v_exp);
end;
$$;

create or replace function public.pyramide_get_booking(p_order text)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object('slot', b.slot, 'qty', b.qty, 'express', b.express)
  from public.pyramide_bookings b
  where b.order_no = upper(p_order) and b.slot > now();
$$;

-- admin: read and edit availability
create or replace function public.pyramide_admin_express(p_password text)
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
  return json_build_object('ok', true, 'enabled', public.pyramide_express_on(), 'hours', coalesce((
    select json_agg(json_build_object('day', e.day, 'hour', e.hour) order by e.day, e.hour)
    from pyramide_express_hours e where e.day >= (now() at time zone 'Europe/Berlin')::date
  ), '[]'::json));
end;
$$;

create or replace function public.pyramide_admin_express_set_day(p_password text, p_day date, p_hours int[])
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
  delete from pyramide_express_hours where day = p_day;
  insert into pyramide_express_hours (day, hour)
  select p_day, h from unnest(coalesce(p_hours, '{}')) h where h between 0 and 23
  on conflict do nothing;
  delete from pyramide_express_hours where day < (now() at time zone 'Europe/Berlin')::date - 1;
  return json_build_object('ok', true);
end;
$$;

create or replace function public.pyramide_admin_express_enable(p_password text, p_enabled boolean)
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
  insert into pyramide_settings (key, value) values ('express_enabled', to_jsonb(coalesce(p_enabled, false)))
  on conflict (key) do update set value = excluded.value;
  return json_build_object('ok', true, 'enabled', coalesce(p_enabled, false));
end;
$$;

-- admin lists also say whether a booking is Express
do $$
declare f text; def text;
begin
  foreach f in array array[
    'public.pyramide_admin_list(text)', 'public.pyramide_admin_threads(text)',
    'public.pyramide_admin_thread(text,uuid)', 'public.pyramide_admin_stats(text)'
  ] loop
    def := pg_get_functiondef(f::regprocedure);
    if position('''express'', b.express' in def) = 0 then
      execute replace(def, '''qty'', b.qty,', '''qty'', b.qty, ''express'', b.express,');
    end if;
  end loop;
end $$;

revoke all on function public.pyramide_express_hours(date, date) from public;
revoke all on function public.pyramide_book(text, timestamptz, text, text, text, int, text, boolean) from public;
revoke all on function public.pyramide_get_booking(text) from public;
revoke all on function public.pyramide_admin_express(text) from public;
revoke all on function public.pyramide_admin_express_set_day(text, date, int[]) from public;
revoke all on function public.pyramide_admin_express_enable(text, boolean) from public;

grant execute on function public.pyramide_express_hours(date, date) to anon, authenticated;
grant execute on function public.pyramide_book(text, timestamptz, text, text, text, int, text, boolean) to anon, authenticated;
grant execute on function public.pyramide_get_booking(text) to anon, authenticated;
grant execute on function public.pyramide_admin_express(text) to anon, authenticated;
grant execute on function public.pyramide_admin_express_set_day(text, date, int[]) to anon, authenticated;
grant execute on function public.pyramide_admin_express_enable(text, boolean) to anon, authenticated;
