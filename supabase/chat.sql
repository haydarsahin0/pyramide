-- Pyramide Göttingen — visitor chat
-- Run after schema.sql (needs pyramide_admin_ok). Safe to re-run.
--
-- Each visitor gets a random secret token in their browser. Only its SHA-256
-- hash is stored, so a thread can only be read by that browser and by you.

create table if not exists public.pyramide_threads (
  id              uuid primary key default gen_random_uuid(),
  token_hash      text not null unique,
  name            text check (name is null or char_length(name) <= 80),
  email           text check (email is null or char_length(email) <= 120),
  order_no        text check (order_no is null or order_no ~ '^PYR-[A-HJ-NP-Z2-9]{6}$'),
  lang            text check (lang in ('de', 'en')),
  admin_unread    int  not null default 0,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create table if not exists public.pyramide_messages (
  id         bigint generated always as identity primary key,
  thread_id  uuid not null references public.pyramide_threads(id) on delete cascade,
  sender     text not null check (sender in ('visitor', 'admin')),
  body       text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists pyramide_messages_thread_idx on public.pyramide_messages (thread_id, id);

alter table public.pyramide_threads enable row level security;
alter table public.pyramide_messages enable row level security;
revoke all on public.pyramide_threads, public.pyramide_messages from anon, authenticated;

create or replace function public.pyramide_token_hash(p_token text)
returns text
language sql
immutable
set search_path = public, extensions
as $$ select encode(digest(coalesce(p_token, ''), 'sha256'), 'hex'); $$;
revoke all on function public.pyramide_token_hash(text) from public, anon, authenticated;

-- ── visitor ──────────────────────────────────────────────────
create or replace function public.pyramide_chat_send(
  p_token text, p_body text, p_name text default null, p_email text default null,
  p_order text default null, p_lang text default 'de'
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
    -- global brake against floods of new threads
    if (select count(*) from public.pyramide_threads where created_at > now() - interval '10 minutes') >= 60 then
      return json_build_object('ok', false, 'error', 'rate_limited');
    end if;
    insert into public.pyramide_threads (token_hash, name, email, order_no, lang)
    values (public.pyramide_token_hash(p_token), v_name, v_email, v_order, case when p_lang in ('de', 'en') then p_lang else 'de' end)
    returning id into v_id;
  else
    select count(*) into v_recent from public.pyramide_messages
      where thread_id = v_id and sender = 'visitor' and created_at > now() - interval '10 minutes';
    if v_recent >= 15 then
      return json_build_object('ok', false, 'error', 'rate_limited');
    end if;
    update public.pyramide_threads
      set name = coalesce(v_name, name), email = coalesce(v_email, email), order_no = coalesce(v_order, order_no)
      where id = v_id;
  end if;

  insert into public.pyramide_messages (thread_id, sender, body) values (v_id, 'visitor', v_body) returning id into v_msg;
  update public.pyramide_threads set admin_unread = admin_unread + 1, last_message_at = now() where id = v_id;
  return json_build_object('ok', true, 'id', v_msg);
end;
$$;

create or replace function public.pyramide_chat_fetch(p_token text, p_after bigint default 0)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(json_agg(json_build_object('id', m.id, 'sender', m.sender, 'body', m.body, 'created_at', m.created_at) order by m.id), '[]'::json)
  from public.pyramide_threads t
  join public.pyramide_messages m on m.thread_id = t.id
  where t.token_hash = public.pyramide_token_hash(p_token) and m.id > coalesce(p_after, 0);
$$;

-- ── admin ────────────────────────────────────────────────────
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
      'last', (select json_build_object('sender', m.sender, 'body', left(m.body, 160))
               from public.pyramide_messages m where m.thread_id = t.id order by m.id desc limit 1)
    ) order by t.last_message_at desc)
    from public.pyramide_threads t
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
begin
  if not public.pyramide_admin_ok(p_password) then
    return json_build_object('ok', false, 'error', 'unauthorized');
  end if;
  update public.pyramide_threads set admin_unread = 0 where id = p_thread;
  return json_build_object('ok', true, 'rows', coalesce((
    select json_agg(json_build_object('id', m.id, 'sender', m.sender, 'body', m.body, 'created_at', m.created_at) order by m.id)
    from public.pyramide_messages m where m.thread_id = p_thread
  ), '[]'::json));
end;
$$;

create or replace function public.pyramide_admin_reply(p_password text, p_thread uuid, p_body text)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_body text := btrim(coalesce(p_body, '')); v_msg bigint;
begin
  if not public.pyramide_admin_ok(p_password) then
    return json_build_object('ok', false, 'error', 'unauthorized');
  end if;
  if char_length(v_body) < 1 or char_length(v_body) > 2000 then
    return json_build_object('ok', false, 'error', 'invalid_body');
  end if;
  if not exists (select 1 from public.pyramide_threads where id = p_thread) then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  insert into public.pyramide_messages (thread_id, sender, body) values (p_thread, 'admin', v_body) returning id into v_msg;
  update public.pyramide_threads set last_message_at = now(), admin_unread = 0 where id = p_thread;
  return json_build_object('ok', true, 'id', v_msg);
end;
$$;

create or replace function public.pyramide_admin_delete_thread(p_password text, p_thread uuid)
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
  delete from public.pyramide_threads where id = p_thread;
  return json_build_object('ok', found);
end;
$$;

revoke all on function public.pyramide_chat_send(text, text, text, text, text, text) from public;
revoke all on function public.pyramide_chat_fetch(text, bigint) from public;
revoke all on function public.pyramide_admin_threads(text) from public;
revoke all on function public.pyramide_admin_thread(text, uuid) from public;
revoke all on function public.pyramide_admin_reply(text, uuid, text) from public;
revoke all on function public.pyramide_admin_delete_thread(text, uuid) from public;

grant execute on function public.pyramide_chat_send(text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.pyramide_chat_fetch(text, bigint) to anon, authenticated;
grant execute on function public.pyramide_admin_threads(text) to anon, authenticated;
grant execute on function public.pyramide_admin_thread(text, uuid) to anon, authenticated;
grant execute on function public.pyramide_admin_reply(text, uuid, text) to anon, authenticated;
grant execute on function public.pyramide_admin_delete_thread(text, uuid) to anon, authenticated;
