-- 04-status.sql — 管理頁「資料庫狀態」用：回傳 Supabase 資料庫大小與文件數。可重複執行。
-- 僅系統管理員可呼叫（其他人得到 QA403）。傳輸量（egress）與請求數 SQL 查不到，請看 Supabase 後台 Reports。
create or replace function public.db_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not app.is_admin() then
    raise exception 'permission denied: db_status' using errcode = 'QA403';
  end if;
  return jsonb_build_object(
    'dbBytes',  pg_database_size(current_database()),
    'docCount', (select count(*) from public.docs),
    'byCol',    (select coalesce(jsonb_object_agg(col, n), '{}'::jsonb)
                   from (select col, count(*) as n from public.docs group by col order by n desc limit 12) t),
    'at',       (extract(epoch from now()) * 1000)::bigint
  );
end $$;

revoke all on function public.db_status() from public, anon;
grant execute on function public.db_status() to authenticated;
