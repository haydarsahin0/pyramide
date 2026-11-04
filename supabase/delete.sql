-- Pyramide Göttingen — admin deletes messages (single or all)
-- Run after notices.sql. Safe to re-run.

create or replace function public.pyramide_admin_delete_message(p_password text, p_id bigint)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_thread uuid;
begin
  if not public.pyramide_admin_ok(p_password) then
    return json_build_object('ok', false, 'error', 'unauthorized');
  end if;
  delete from pyramide_messages where id = p_id returning thread_id into v_thread;
  if v_thread is not null then
    update pyramide_threads t set
      last_message_at = coalesce((select max(m.created_at) from pyramide_messages m where m.thread_id = t.id), t.created_at),
      admin_unread = least(t.admin_unread, (select count(*) from pyramide_messages m where m.thread_id = t.id and m.sender = 'visitor'))
    where t.id = v_thread;
  end if;
  return json_build_object('ok', v_thread is not null);
end;
$$;

create or replace function public.pyramide_admin_delete_notice(p_password text, p_id bigint)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_b bigint;
begin
  if not public.pyramide_admin_ok(p_password) then
    return json_build_object('ok', false, 'error', 'unauthorized');
  end if;
  delete from pyramide_notices where id = p_id returning broadcast_id into v_b;
  if v_b is not null then
    update pyramide_broadcasts set recipients = (select count(*) from pyramide_notices where broadcast_id = v_b) where id = v_b;
    delete from pyramide_broadcasts b where b.id = v_b and not exists (select 1 from pyramide_notices n where n.broadcast_id = b.id);
  end if;
  return json_build_object('ok', found);
end;
$$;

create or replace function public.pyramide_admin_delete_broadcast(p_password text, p_id bigint)
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
  delete from pyramide_broadcasts where id = p_id;   -- notices go with it (on delete cascade)
  return json_build_object('ok', found);
end;
$$;

-- p_what: 'chats' (all conversations), 'notices' (all announcements), 'all'
create or replace function public.pyramide_admin_purge(p_password text, p_what text)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_t int := 0; v_n int := 0;
begin
  if not public.pyramide_admin_ok(p_password) then
    return json_build_object('ok', false, 'error', 'unauthorized');
  end if;
  if p_what in ('chats', 'all') then
    delete from pyramide_threads where true;   -- messages go with them
    get diagnostics v_t = row_count;
  end if;
  if p_what in ('notices', 'all') then
    delete from pyramide_notices where true;
    get diagnostics v_n = row_count;
    delete from pyramide_broadcasts where true;
  end if;
  return json_build_object('ok', true, 'threads', v_t, 'notices', v_n);
end;
$$;

-- admin chat view needs notice ids to delete them
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
    select json_agg(json_build_object('id', n.id, 'order_no', n.order_no, 'body', n.body, 'created_at', n.created_at, 'seen_at', n.seen_at, 'broadcast_id', n.broadcast_id) order by n.id)
    from pyramide_notices n where n.order_no = any (select upper(o) from unnest(coalesce(p_orders, '{}')) o)
  ), '[]'::json));
end;
$$;

revoke all on function public.pyramide_admin_delete_message(text, bigint) from public;
revoke all on function public.pyramide_admin_delete_notice(text, bigint) from public;
revoke all on function public.pyramide_admin_delete_broadcast(text, bigint) from public;
revoke all on function public.pyramide_admin_purge(text, text) from public;
grant execute on function public.pyramide_admin_delete_message(text, bigint) to anon, authenticated;
grant execute on function public.pyramide_admin_delete_notice(text, bigint) to anon, authenticated;
grant execute on function public.pyramide_admin_delete_broadcast(text, bigint) to anon, authenticated;
grant execute on function public.pyramide_admin_purge(text, text) to anon, authenticated;
