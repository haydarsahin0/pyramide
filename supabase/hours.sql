-- Pyramide Göttingen — admin-defined standard pickup hours
-- Run after express.sql. Safe to re-run.
--
-- Weekly default (ISO weekday 1 = Monday … 7 = Sunday) + optional per-date
-- overrides. An hour h means 30-minute slots at h:00 and h:30.

insert into public.pyramide_settings (key, value)
values ('standard_week', '{"1":[10,11,12,13,14,15,16,17,18,19],"2":[10,11,12,13,14,15,16,17,18,19],"3":[10,11,12,13,14,15,16,17,18,19],"4":[10,11,12,13,14,15,16,17,18,19],"5":[10,11,12,13,14,15,16,17,18,19],"6":[10,11,12,13,14,15,16,17,18,19],"7":[10,11,12,13,14,15,16,17,18,19]}'::jsonb)
on conflict (key) do nothing;

create table if not exists public.pyramide_standard_days (
  day   date primary key,
  hours smallint[] not null default '{}'
);
alter table public.pyramide_standard_days enable row level security;
revoke all on public.pyramide_standard_days from anon, authenticated;

-- effective open hours for one date
create or replace function public.pyramide_std_hours_for(p_day date)
returns smallint[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select d.hours from pyramide_standard_days d where d.day = p_day),
    (select coalesce(array_agg(x::smallint order by x::int), '{}')
       from jsonb_array_elements_text(
         coalesce((select value from pyramide_settings where key = 'standard_week') -> extract(isodow from p_day)::int::text, '[]'::jsonb)) x)
  );
$$;
revoke all on function public.pyramide_std_hours_for(date) from public, anon, authenticated;

-- public: weekly default + effective hours for the next days
create or replace function public.pyramide_standard_hours(p_days int default 21)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'week', (select value from pyramide_settings where key = 'standard_week'),
    'days', (
      select json_agg(json_build_object('day', d::date, 'hours', public.pyramide_std_hours_for(d::date)) order by d)
      from generate_series((now() at time zone 'Europe/Berlin')::date,
                           (now() at time zone 'Europe/Berlin')::date + least(greatest(coalesce(p_days, 21), 1), 40),
                           interval '1 day') d
    )
  );
$$;

-- booking: standard slots must be inside the hours you set
do $$
declare def text := pg_get_functiondef('public.pyramide_book(text,timestamptz,text,text,text,integer,text,boolean)'::regprocedure);
begin
  if position('pyramide_std_hours_for' in def) = 0 then
    if position('or extract(hour from v_local) < 10
       or extract(hour from v_local) > 19' in def) = 0 then
      raise exception 'pattern not found in pyramide_book';
    end if;
    execute replace(def,
      'or extract(hour from v_local) < 10
       or extract(hour from v_local) > 19',
      'or not (extract(hour from v_local)::smallint = any (public.pyramide_std_hours_for(v_local::date)))');
  end if;
end $$;

-- admin
create or replace function public.pyramide_admin_hours(p_password text)
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
  return json_build_object('ok', true,
    'week', (select value from pyramide_settings where key = 'standard_week'),
    'overrides', coalesce((select json_agg(json_build_object('day', d.day, 'hours', d.hours) order by d.day)
                           from pyramide_standard_days d where d.day >= (now() at time zone 'Europe/Berlin')::date), '[]'::json));
end;
$$;

create or replace function public.pyramide_admin_set_week(p_password text, p_week jsonb)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare k text; clean jsonb := '{}'::jsonb;
begin
  if not public.pyramide_admin_ok(p_password) then
    return json_build_object('ok', false, 'error', 'unauthorized');
  end if;
  for k in select unnest(array['1','2','3','4','5','6','7']) loop
    clean := clean || jsonb_build_object(k, coalesce((
      select jsonb_agg(distinct x::int order by x::int) from jsonb_array_elements_text(coalesce(p_week -> k, '[]'::jsonb)) x
      where x ~ '^\d{1,2}$' and x::int between 0 and 23), '[]'::jsonb));
  end loop;
  insert into pyramide_settings (key, value) values ('standard_week', clean)
  on conflict (key) do update set value = excluded.value;
  return json_build_object('ok', true, 'week', clean);
end;
$$;

-- p_hours null = back to the weekly default for that date
create or replace function public.pyramide_admin_set_std_day(p_password text, p_day date, p_hours int[])
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
  if p_hours is null then
    delete from pyramide_standard_days where day = p_day;
  else
    insert into pyramide_standard_days (day, hours)
    values (p_day, coalesce((select array_agg(distinct h::smallint order by h::smallint) from unnest(p_hours) h where h between 0 and 23), '{}'))
    on conflict (day) do update set hours = excluded.hours;
  end if;
  delete from pyramide_standard_days where day < (now() at time zone 'Europe/Berlin')::date - 1;
  return json_build_object('ok', true);
end;
$$;

revoke all on function public.pyramide_standard_hours(int) from public;
revoke all on function public.pyramide_admin_hours(text) from public;
revoke all on function public.pyramide_admin_set_week(text, jsonb) from public;
revoke all on function public.pyramide_admin_set_std_day(text, date, int[]) from public;
grant execute on function public.pyramide_standard_hours(int) to anon, authenticated;
grant execute on function public.pyramide_admin_hours(text) to anon, authenticated;
grant execute on function public.pyramide_admin_set_week(text, jsonb) to anon, authenticated;
grant execute on function public.pyramide_admin_set_std_day(text, date, int[]) to anon, authenticated;
