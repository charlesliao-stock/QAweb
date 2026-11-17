-- 03-rls.sql — 把 firestore.rules 對應到 Supabase。可重複執行。
--
-- 前提：已在 Supabase 後台 Authentication → Third-Party Auth 加入 Firebase（專案 ID：nurseboard-492316），
--       且每個 Firebase 使用者都已有自訂標記 role = 'authenticated'（scripts/set-supabase-claims.mjs）。
--
-- 結構：
--   讀取：RLS SELECT 政策（app.can_read）
--   寫入：RLS 只放行「已登入」；細部權限由 BEFORE 觸發器 app.guard() 以 OLD／NEW 判斷
--         （Firestore rules 的 resource／request.resource 對應 OLD／NEW）
--   跨文件的「批次提交後」檢查（existsAfter／getAfter）：延遲到交易提交時的 constraint trigger
--   service_role／postgres（遷移腳本、SQL Editor）不受觸發器限制。
--
-- 與 firestore.rules 的差異：
--   * users 的 get／list 在 Firestore 分開；這裡合併成一條讀取規則（幹事也能「單筆」讀人員，略寬）
--   * 其餘規則一一對應；未列入的集合一律拒絕

create schema if not exists app;

-- ---------- 身分 ----------
create or replace function app.staff_id() returns text
language sql stable as $$
  select coalesce(nullif(auth.jwt()->>'staffId', ''), split_part(coalesce(auth.jwt()->>'email', ''), '@', 1), '')
$$;

create or replace function app.my_data() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select data from public.docs where col = 'users' and id = app.staff_id()), '{}'::jsonb)
$$;

create or replace function app.has_role(r text) returns boolean
language sql stable security definer set search_path = public as $$
  select app.staff_id() <> '' and jsonb_exists(coalesce(app.my_data()->'roles', '[]'::jsonb), r)
$$;

create or replace function app.is_admin() returns boolean
language sql stable as $$ select app.has_role('系統管理員') $$;

create or replace function app.is_ganshi() returns boolean
language sql stable as $$ select app.has_role('品管執行幹事') or app.is_admin() $$;

create or replace function app.can_manage_schedule() returns boolean
language sql stable as $$
  select app.has_role('召集人') or app.has_role('品管組召集人')
      or app.has_role('執行幹事') or app.has_role('品管組執行幹事') or app.is_admin()
$$;

create or replace function app.is_unit_head_of(d jsonb) returns boolean
language sql stable as $$
  select app.has_role('護理長')
     and coalesce(app.my_data()->>'unitCode', '') <> ''
     and coalesce(d->>'unitCode', '') = coalesce(app.my_data()->>'unitCode', '')
$$;

create or replace function app.is_supervisor_of(d jsonb) returns boolean
language sql stable as $$
  select app.has_role('督導')
     and jsonb_exists(coalesce(app.my_data()->'titleUnitCodes', '[]'::jsonb), coalesce(d->>'unitCode', ''))
$$;

-- ---------- 集合分類 ----------
create or replace function app.col_kind(c text) returns text
language sql immutable as $$
  select case
    when c in ('systemParams','configs','uiThemes','roles','roleLevels','permissionTemplates') then 'admin'
    when c in ('units','groups','titles','titleLevels','indicators','guidelineDocs','reviewReviewers',
               'indicatorYearSchedules','indicatorSchedules','indicatorAssignments') then 'ganshi'
    when c like 'indicators/%/versions' then 'ganshi'
    when c in ('schedules','reviews','capa','reportTemplates') then 'open'
    when c in ('users','reviewSummaries','notifications','auditLogs','reviewTasks','reviewQuotaGroups',
               'reviewRecords','reviewArchives','reviewEditRequests','reviewDrafts','reviewReservations',
               'unlockRequests') then 'special'
    else 'unknown'
  end
$$;

-- 取得審查任務的審查員（reviewDrafts 的權限用）；security definer 避免遞迴
create or replace function app.task_reviewer(task_id text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select data->>'reviewerId' from public.docs where col = 'reviewTasks' and id = task_id), '')
$$;

-- ---------- 讀取 ----------
create or replace function app.can_read(c text, i text, d jsonb) returns boolean
language sql stable as $$
  select app.staff_id() <> '' and case app.col_kind(c)
    when 'unknown' then false
    when 'special' then case c
      when 'users' then i = app.staff_id() or app.is_admin() or app.is_ganshi()
                        or app.is_unit_head_of(d) or app.is_supervisor_of(d)
      when 'notifications' then coalesce(d->>'userId', '') = app.staff_id()
      when 'auditLogs' then app.is_admin()
      else true
    end
    else true
  end
$$;

-- ---------- 寫入（觸發器用） ----------
create or replace function app.nz(j jsonb) returns jsonb language sql immutable as $$ select coalesce(j, 'null'::jsonb) $$;

create or replace function app.same_snapshot(o jsonb, n jsonb) returns boolean
language sql immutable as $$
  select app.nz(o->'indicatorId') = app.nz(n->'indicatorId')
     and app.nz(o->'year') = app.nz(n->'year')
     and app.nz(o->'month') = app.nz(n->'month')
     and app.nz(o->'unitId') = app.nz(n->'unitId')
     and app.nz(o->'indicatorVersionAtSchedule') = app.nz(n->'indicatorVersionAtSchedule')
     and app.nz(o->'thresholdAtSchedule') = app.nz(n->'thresholdAtSchedule')
     and app.nz(o->'thresholdRuleAtSchedule') = app.nz(n->'thresholdRuleAtSchedule')
     and app.nz(o->'scheduleStartYear') = app.nz(n->'scheduleStartYear')
     and app.nz(o->'scheduleStartMonth') = app.nz(n->'scheduleStartMonth')
     and app.nz(o->'scheduleEndYear') = app.nz(n->'scheduleEndYear')
     and app.nz(o->'scheduleEndMonth') = app.nz(n->'scheduleEndMonth')
$$;

-- 週期排程名額：quotaGroupId 存在時，群組必須存在、名額文件 id 對得上、且在群組 slotIds 內
create or replace function app.valid_quota_slot(i text, d jsonb) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(d->>'quotaSlotDocId', '') = i
     and exists (
       select 1 from public.docs g
        where g.col = 'reviewQuotaGroups' and g.id = coalesce(d->>'quotaGroupId', '')
          and jsonb_exists(coalesce(g.data->'slotIds', '[]'::jsonb), i))
$$;

create or replace function app.can_create(c text, i text, d jsonb) returns boolean
language sql stable as $$
  select app.staff_id() <> '' and case app.col_kind(c)
    when 'admin' then app.is_admin()
    when 'ganshi' then app.is_ganshi()
    when 'open' then true
    when 'special' then case c
      when 'users' then app.is_admin()
      when 'reviewSummaries' then false
      when 'notifications' then false
      when 'auditLogs' then true
      when 'reviewTasks' then true
      when 'reviewQuotaGroups' then app.can_manage_schedule()
      when 'reviewRecords' then (not jsonb_exists(d, 'quotaGroupId') or app.valid_quota_slot(i, d))
      when 'reviewArchives' then app.can_manage_schedule()
      when 'reviewEditRequests' then coalesce(d->>'requestedBy', '') = app.staff_id()
                                     and coalesce(d->>'status', '') = 'pending'
      when 'reviewDrafts' then coalesce(d->>'createdBy', '') = app.staff_id()
      when 'reviewReservations' then coalesce(d->>'uniqueKey', '') = i
                                     and coalesce(d->>'ownerId', '') = app.staff_id()
      when 'unlockRequests' then coalesce(d->>'requestedBy', '') = app.staff_id()
                                 and coalesce(d->>'status', '') = 'pending'
      else false
    end
    else false
  end
$$;

create or replace function app.can_update(c text, i text, o jsonb, n jsonb) returns boolean
language sql stable as $$
  select app.staff_id() <> '' and case app.col_kind(c)
    when 'admin' then app.is_admin()
    when 'ganshi' then app.is_ganshi()
    when 'open' then true
    when 'special' then case c
      when 'users' then app.is_admin() or (
          i = app.staff_id()
          and app.nz(o->'roles') = app.nz(n->'roles')
          and coalesce(o->>'status', '') = coalesce(n->>'status', ''))
      when 'notifications' then coalesce(o->>'userId', '') = app.staff_id()
          and (n - 'read' - 'readAt') = (o - 'read' - 'readAt')
          and jsonb_typeof(n->'read') = 'boolean'
      when 'reviewTasks' then app.same_snapshot(o, n)
      when 'reviewQuotaGroups' then app.can_manage_schedule()
      when 'reviewRecords' then app.same_snapshot(o, n) and (
          (not jsonb_exists(o, 'quotaGroupId') and not jsonb_exists(n, 'quotaGroupId'))
          or (jsonb_exists(o, 'quotaGroupId')
              and coalesce(n->>'quotaGroupId', '') = coalesce(o->>'quotaGroupId', '')
              and coalesce(n->>'quotaSlotDocId', '') = i
              and coalesce(o->>'quotaSlotDocId', '') = i
              and coalesce((n->>'version')::numeric, 0) = coalesce((o->>'version')::numeric, 0) + 1))
      when 'reviewArchives' then app.can_manage_schedule()
      when 'reviewEditRequests' then app.can_manage_schedule()
      when 'reviewDrafts' then (
          coalesce(o->>'createdBy', '') = app.staff_id() or app.is_admin()
          or app.task_reviewer(coalesce(o->>'taskId', '')) = app.staff_id())
          and coalesce(n->>'createdBy', '') = coalesce(o->>'createdBy', '')
      when 'reviewReservations' then coalesce(n->>'uniqueKey', '') = i
          and coalesce(n->>'ownerId', '') = coalesce(o->>'ownerId', '')
      when 'unlockRequests' then app.is_ganshi()
      else false     -- auditLogs（只能新增）、reviewSummaries（僅後端可寫）
    end
    else false
  end
$$;

create or replace function app.can_delete(c text, i text, o jsonb) returns boolean
language sql stable as $$
  select app.staff_id() <> '' and case app.col_kind(c)
    when 'admin' then app.is_admin()
    when 'ganshi' then app.is_ganshi()
    when 'open' then true
    when 'special' then case c
      when 'users' then app.is_admin()
      when 'reviewTasks' then true
      when 'reviewRecords' then app.is_admin()
      when 'reviewQuotaGroups' then app.is_admin()
      when 'reviewArchives' then app.is_admin()
      when 'reviewEditRequests' then app.is_admin()
      when 'unlockRequests' then app.is_admin()
      when 'reviewDrafts' then coalesce(o->>'createdBy', '') = app.staff_id() or app.is_admin()
                               or app.task_reviewer(coalesce(o->>'taskId', '')) = app.staff_id()
      when 'reviewReservations' then true
      else false
    end
    else false
  end
$$;

-- ---------- 觸發器 ----------
create or replace function app.guard() returns trigger
language plpgsql as $$
declare ok boolean;
begin
  -- 只管瀏覽器（authenticated）。service_role／postgres（遷移、維運）放行。
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' then
    ok := app.can_create(new.col, new.id, new.data);
  elsif tg_op = 'UPDATE' then
    ok := new.col = old.col and new.id = old.id
          and app.can_update(old.col, old.id, old.data, new.data);
  else
    ok := app.can_delete(old.col, old.id, old.data);
  end if;
  if not ok then
    raise exception 'permission denied: % on %/%', tg_op, coalesce(new.col, old.col), coalesce(new.id, old.id)
      using errcode = 'QA403';
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists docs_guard on public.docs;
create trigger docs_guard before insert or update or delete on public.docs
  for each row execute function app.guard();

-- 交易提交時才檢查（對應 Firestore 的 existsAfter／getAfter：整批寫完再看）：
--   reviewRecords／reviewDrafts 帶 uniqueKey → 必須有對應的 reviewReservations，且指回自己
--   reviewReservations → 指向的文件必須存在，且該文件的 uniqueKey 等於預約 id
create or replace function app.guard_after() returns trigger
language plpgsql as $$
declare ok boolean := true; uk text; tc text; ti text;
begin
  if current_user <> 'authenticated' then return null; end if;
  if new.col in ('reviewRecords', 'reviewDrafts') then
    uk := coalesce(new.data->>'uniqueKey', '');
    if uk <> '' then
      select exists (
        select 1 from public.docs r
         where r.col = 'reviewReservations' and r.id = uk
           and coalesce(r.data->>'targetCollection', '') = new.col
           and coalesce(r.data->>'targetId', '') = new.id) into ok;
    end if;
  elsif new.col = 'reviewReservations' then
    tc := coalesce(new.data->>'targetCollection', '');
    ti := coalesce(new.data->>'targetId', '');
    select exists (
      select 1 from public.docs t
       where t.col = tc and t.id = ti and tc in ('reviewDrafts', 'reviewRecords')
         and coalesce(t.data->>'uniqueKey', '') = new.id) into ok;
  end if;
  if not ok then
    raise exception 'permission denied: reservation mismatch for %/%', new.col, new.id using errcode = 'QA403';
  end if;
  return null;
end $$;

drop trigger if exists docs_guard_after on public.docs;
create constraint trigger docs_guard_after after insert or update on public.docs
  deferrable initially deferred for each row execute function app.guard_after();

-- ---------- RLS ----------
alter table public.docs enable row level security;

drop policy if exists docs_select on public.docs;
drop policy if exists docs_insert on public.docs;
drop policy if exists docs_update on public.docs;
drop policy if exists docs_delete on public.docs;

create policy docs_select on public.docs for select to authenticated
  using (app.can_read(col, id, data));
-- 寫入：RLS 只確認已登入；細部權限在 app.guard() 觸發器
create policy docs_insert on public.docs for insert to authenticated with check (app.staff_id() <> '');
create policy docs_update on public.docs for update to authenticated using (app.can_read(col, id, data)) with check (app.staff_id() <> '');
create policy docs_delete on public.docs for delete to authenticated using (app.can_read(col, id, data));

-- anon（未登入）不給任何權限；authenticated 要有表權限才能走到 RLS
revoke all on public.docs from anon;
grant select, insert, update, delete on public.docs to authenticated;
grant usage on schema app to authenticated;
grant execute on all functions in schema app to authenticated;
grant execute on function public.apply_ops(jsonb) to authenticated;

-- 錯誤碼約定：業務規則拒絕一律是 SQLSTATE 'QA403'（PostgREST 回 HTTP 400，body.code='QA403'）；
-- 前端據此判斷「這是被規則拒絕」而非「資料庫掛了」，不會觸發故障轉移／斷路器。
-- 42501（缺少表權限、RLS 擋下）代表登入／設定有問題，前端會當成主庫不可用而轉移到 Firebase。
