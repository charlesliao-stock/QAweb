-- v1.84.1：信箱去掉了職編開頭的 0（職編 0930462 → 信箱 930462@kmuh.org.tw），
-- 所以人員職編改由 Firebase 自訂標記 staffId 提供；沒有標記的帳號（例如手動建立的 admin）
-- 仍退回信箱 @ 前面的部分，向下相容。
-- 在 Supabase 後台 SQL Editor 執行一次即可（可重複執行，與部署順序無關）。
create or replace function app.staff_id() returns text
language sql stable as $$
  select coalesce(nullif(auth.jwt()->>'staffId', ''), split_part(coalesce(auth.jwt()->>'email', ''), '@', 1), '')
$$;
