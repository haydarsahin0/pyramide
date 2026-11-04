-- Pyramide Göttingen — Express = pickup within 1 hour (no time choice)
-- Run after hours.sql. Safe to re-run.
--
-- Express is offered while the current Berlin hour is opened in admin.html.
-- The server stamps the booking with "now"; the customer comes within 60 minutes.
-- Standard bookings must fall inside the standard hours (pyramide_std_hours_for).

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
  v_slot  timestamptz := p_slot;
  v_local timestamp;
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
    v_slot := date_trunc('milliseconds', clock_timestamp());
    v_local := v_slot at time zone 'Europe/Berlin';
    if not public.pyramide_express_on()
       or not exists (select 1 from pyramide_express_hours e
                      where e.day = v_local::date and e.hour = extract(hour from v_local)) then
      return json_build_object('ok', false, 'error', 'express_unavailable');
    end if;
  else
    v_local := v_slot at time zone 'Europe/Berlin';
    if v_slot is null
       or v_slot < now() + interval '30 minutes'
       or v_slot > now() + interval '30 days'
       or not (extract(hour from v_local)::smallint = any (public.pyramide_std_hours_for(v_local::date)))
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
    values (upper(p_order), v_slot, v_name, v_email, p_qty, case when p_lang in ('de', 'en') then p_lang else 'de' end, v_vis, v_exp)
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
  return json_build_object('ok', true, 'slot', v_slot, 'express', v_exp);
end;
$$;

-- an Express pickup is "upcoming" for 60 minutes after it was booked
create or replace function public.pyramide_get_booking(p_order text)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object('slot', b.slot, 'qty', b.qty, 'express', b.express)
  from public.pyramide_bookings b
  where b.order_no = upper(p_order)
    and b.slot > now() - case when b.express then interval '60 minutes' else interval '0 minutes' end;
$$;
