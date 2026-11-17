-- 在 01（public.docs 表，即先前的 supabase.sql）之後執行；可重複執行（create or replace）。
-- apply_ops：一批操作在單一交易內套用，過時的操作不生效（可安全重送）。
--   set：不存在 → INSERT；存在且 ts 不比現有舊 → UPDATE；比現有舊 → 略過
--   del：存在且 ts 不比現有舊 → DELETE；比現有舊 → 略過
-- 刻意「先查再 INSERT／UPDATE」而不用 ON CONFLICT：
--   1. 建立與更新走不同的權限檢查（03-rls.sql 的 guard 觸發器分得出 INSERT／UPDATE）
--   2. 同時建立同一份文件時，第二個會得到唯一鍵衝突（對應 Firestore 的 create-only 鎖，例如 reviewReservations）
-- security invoker：套用呼叫者自己的權限。

create or replace function public.apply_ops(p_ops jsonb)
returns integer
language plpgsql
security invoker
as $$
declare
  op  jsonb;
  n   integer := 0;
  cur bigint;
  r   integer;
  t   bigint;
begin
  for op in select * from jsonb_array_elements(p_ops) loop
    t := (op->>'ts')::bigint;
    select ts into cur from public.docs where col = op->>'col' and id = op->>'id';

    if op->>'kind' = 'set' then
      if not found then
        insert into public.docs (col, id, data, ts, deleted)
        values (op->>'col', op->>'id', op->'data', t, false);
        n := n + 1;
      elsif cur <= t then
        update public.docs
           set data = op->'data', ts = t, deleted = false
         where col = op->>'col' and id = op->>'id';
        get diagnostics r = row_count;
        n := n + r;
      end if;
    else
      if found and cur <= t then
        delete from public.docs where col = op->>'col' and id = op->>'id';
        get diagnostics r = row_count;
        n := n + r;
      end if;
    end if;
  end loop;
  return n;
end $$;

-- 讀取用的 jsonb 包含查詢（data=cs.{...}）加速
create index if not exists docs_data_gin on public.docs using gin (data jsonb_path_ops);
