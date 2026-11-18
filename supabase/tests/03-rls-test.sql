-- 本機 Postgres 測試：psql -v ON_ERROR_STOP=1 -f 00-supabase-stub.sql -f ../01-docs.sql -f ../02-apply-ops.sql -f ../03-rls.sql -f 03-rls-test.sql
\set ON_ERROR_STOP on
begin;
create schema test;
create table test.results(name text, ok boolean, detail text);

-- 以某人身分（authenticated＋JWT email）執行單一語句；回傳 ok 或 err:SQLSTATE。
create function test.as_user(email text, stmt text) returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('email', email, 'role', 'authenticated', 'sub', email)::text, true);
  execute 'set local role authenticated';
  begin
    execute stmt;
    execute 'set constraints all immediate';   -- 立即跑「交易提交時」的延遲檢查
    execute 'set constraints all deferred';
    execute 'reset role';
    return 'ok';
  exception when others then
    execute 'reset role';
    execute 'set constraints all deferred';
    return 'err:' || sqlstate;
  end;
end $$;

create function test.count_as(email text, q text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('email', email, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  execute q into n;
  execute 'reset role';
  return n;
end $$;

create function test.check(n text, got anyelement, want anyelement) returns void language plpgsql as $$
begin
  insert into test.results values (n, got is not distinct from want, 'got=' || coalesce(got::text,'null') || ' want=' || coalesce(want::text,'null'));
end $$;

create function test.op(kind text, col text, id text, ts bigint, data jsonb default null) returns text language sql as $$
  select format('select public.apply_ops(%L::jsonb)',
    jsonb_build_array(jsonb_build_object('kind',kind,'col',col,'id',id,'ts',ts,'data',data))::text)
$$;

-- ---- 種子資料（以 postgres 身分，不受守門限制）----
insert into public.docs(col,id,data,ts) values
 ('users','admin','{"roles":["系統管理員"],"status":"active","unitCode":"A0"}',1),
 ('users','gan','{"roles":["品管執行幹事"],"status":"active"}',1),
 ('users','head','{"roles":["護理長"],"status":"active","unitCode":"U1"}',1),
 ('users','nurse','{"roles":["護理師"],"status":"active","unitCode":"U1","name":"小明"}',1),
 ('users','other','{"roles":[],"status":"active","unitCode":"U2"}',1),
 ('users','sup','{"roles":["督導"],"status":"active","titleUnitCodes":["U1"]}',1),
 ('systemParams','p1','{"v":1}',1),
 ('indicators','i1','{"name":"跌倒"}',1),
 ('notifications','n1','{"userId":"nurse","read":false,"title":"hi"}',1),
 ('notifications','n2','{"userId":"other","read":false}',1),
 ('reviewTasks','t1','{"indicatorId":"i1","year":2026,"month":3,"unitId":"U1","reviewerId":"nurse","status":"open"}',1),
 ('reviewRecords','rr1','{"reviewerId":"nurse","reviewedPersonEmpNo":"受審者","unitId":"U1"}',1),
 ('reviewRecords','rr2','{"reviewerId":"other","reviewedPersonEmpNo":"受審者","unitId":"U2"}',1),
 ('capa','cp1','{"ownerId":"nurse","unitCode":"U1"}',1),
 ('reviewQuotaGroups','g1','{"slotIds":["s1","s2"]}',1);

-- ---- 未登入／未知集合 ----
do $$ declare r text; begin
  begin set local role anon; perform count(*) from public.docs; r := 'ok'; reset role;
  exception when others then reset role; r := 'err:' || sqlstate; end;
  perform test.check('anon 不能讀', r, 'err:42501');
end $$;

-- ---- 讀取 ----
select test.check('登入者可讀系統參數', test.count_as('nurse', $$select count(*) from public.docs where col='systemParams'$$), 1::bigint);
select test.check('一般人只看得到自己的 users 文件', test.count_as('other', $$select count(*) from public.docs where col='users'$$), 1::bigint);
select test.check('護理長看得到本單位人員（head+nurse）', test.count_as('head', $$select count(*) from public.docs where col='users'$$), 2::bigint);
select test.check('督導看得到轄區單位人員', test.count_as('sup', $$select count(*) from public.docs where col='users'$$), 3::bigint);  -- head, nurse, + self
select test.check('管理員看得到全部人員', test.count_as('admin', $$select count(*) from public.docs where col='users'$$), 6::bigint);
select test.check('幹事可列出人員清單', test.count_as('gan', $$select count(*) from public.docs where col='users'$$), 6::bigint);
select test.check('通知只看得到自己的', test.count_as('nurse', $$select count(*) from public.docs where col='notifications'$$), 1::bigint);
select test.check('稽核紀錄非管理員讀不到', test.count_as('nurse', $$select count(*) from public.docs where col='auditLogs'$$), 0::bigint);
select test.check('審查員可讀本人紀錄', test.count_as('nurse', $$select count(*) from public.docs where col='reviewRecords' and id='rr1'$$), 1::bigint);
select test.check('無關單位不可讀他人紀錄', test.count_as('other', $$select count(*) from public.docs where col='reviewRecords' and id='rr1'$$), 0::bigint);
select test.check('護理長可讀本單位審查紀錄', test.count_as('head', $$select count(*) from public.docs where col='reviewRecords' and id='rr1'$$), 1::bigint);
select test.check('護理長不可讀外單位審查紀錄', test.count_as('head', $$select count(*) from public.docs where col='reviewRecords' and id='rr2'$$), 0::bigint);
select test.check('案件負責人可讀 CAPA', test.count_as('nurse', $$select count(*) from public.docs where col='capa' and id='cp1'$$), 1::bigint);
select test.check('無關人員不可讀 CAPA', test.count_as('other', $$select count(*) from public.docs where col='capa' and id='cp1'$$), 0::bigint);

-- ---- 角色型寫入 ----
select test.check('非管理員不能寫 systemParams', test.as_user('nurse', test.op('set','systemParams','p2',10,'{"v":2}')), 'err:QA403');
select test.check('管理員可寫 systemParams', test.as_user('admin', test.op('set','systemParams','p2',10,'{"v":2}')), 'ok');
select test.check('非幹事不能寫 indicators', test.as_user('nurse', test.op('set','indicators','i2',10,'{"name":"x"}')), 'err:QA403');
select test.check('幹事可寫 indicators', test.as_user('gan', test.op('set','indicators','i2',10,'{"name":"x"}')), 'ok');
select test.check('幹事可寫指標版本子集合', test.as_user('gan', test.op('set','indicators/i2/versions','v1',10,'{"v":1}')), 'ok');
select test.check('未知集合一律拒絕', test.as_user('admin', test.op('set','mystery','m1',10,'{}')), 'err:QA403');
select test.check('reviewSummaries 用戶端不可寫（連管理員）', test.as_user('admin', test.op('set','reviewSummaries','s1',10,'{}')), 'err:QA403');

-- ---- users ----
select test.check('本人可改自己的姓名', test.as_user('nurse', test.op('set','users','nurse',20,'{"roles":["護理師"],"status":"active","unitCode":"U1","name":"小華"}')), 'ok');
select test.check('本人不可改自己的角色', test.as_user('nurse', test.op('set','users','nurse',30,'{"roles":["系統管理員"],"status":"active","unitCode":"U1"}')), 'err:QA403');
select test.check('本人不可改自己的狀態', test.as_user('nurse', test.op('set','users','nurse',30,'{"roles":["護理師"],"status":"disabled","unitCode":"U1"}')), 'err:QA403');
select test.check('一般人不能新增人員', test.as_user('nurse', test.op('set','users','new1',30,'{"roles":[]}')), 'err:QA403');
select test.check('管理員可新增人員', test.as_user('admin', test.op('set','users','new1',30,'{"roles":[]}')), 'ok');

-- ---- notifications ----
select test.check('本人可標已讀', test.as_user('nurse', test.op('set','notifications','n1',40,'{"userId":"nurse","read":true,"readAt":5,"title":"hi"}')), 'ok');
select test.check('通知不可改其他欄位', test.as_user('nurse', test.op('set','notifications','n1',50,'{"userId":"nurse","read":true,"title":"hacked"}')), 'err:QA403');
select test.check('用戶端不可建立通知', test.as_user('admin', test.op('set','notifications','n9',40,'{"userId":"nurse","read":false}')), 'err:QA403');

-- ---- auditLogs ----
select test.check('任何登入者可新增稽核', test.as_user('nurse', test.op('set','auditLogs','a1',40,'{"e":1}')), 'ok');
select test.check('稽核不可修改', test.as_user('admin', test.op('set','auditLogs','a1',50,'{"e":2}')), 'err:QA403');
select test.check('稽核不可刪除', test.as_user('admin', test.op('del','auditLogs','a1',50)), 'err:QA403');
select test.check('管理員讀得到稽核', test.count_as('admin', $$select count(*) from public.docs where col='auditLogs'$$), 1::bigint);

-- ---- reviewTasks 快照 ----
select test.check('任務狀態可更新', test.as_user('nurse', test.op('set','reviewTasks','t1',60,'{"indicatorId":"i1","year":2026,"month":3,"unitId":"U1","reviewerId":"nurse","status":"done"}')), 'ok');
select test.check('任務快照欄位不可改', test.as_user('nurse', test.op('set','reviewTasks','t1',70,'{"indicatorId":"i9","year":2026,"month":3,"unitId":"U1","reviewerId":"nurse","status":"done"}')), 'err:QA403');

-- ---- reviewRecords／名額 ----
select test.check('無名額欄位的紀錄可建立', test.as_user('nurse', test.op('set','reviewRecords','r0',80,'{"indicatorId":"i1","year":2026,"reviewerId":"nurse","submittedBy":"nurse"}')), 'ok');
select test.check('名額文件 id 不在群組內 → 拒絕', test.as_user('nurse', test.op('set','reviewRecords','zz',80,'{"quotaGroupId":"g1","quotaSlotDocId":"zz","reviewerId":"nurse","submittedBy":"nurse"}')), 'err:QA403');
select test.check('合法名額可建立', test.as_user('nurse', test.op('set','reviewRecords','s1',80,'{"quotaGroupId":"g1","quotaSlotDocId":"s1","version":1,"indicatorId":"i1","reviewerId":"nurse","submittedBy":"nurse"}')), 'ok');
select test.check('名額紀錄更新必須 version+1', test.as_user('nurse', test.op('set','reviewRecords','s1',90,'{"quotaGroupId":"g1","quotaSlotDocId":"s1","version":1,"indicatorId":"i1","reviewerId":"nurse","submittedBy":"nurse"}')), 'err:QA403');
select test.check('version+1 可更新', test.as_user('nurse', test.op('set','reviewRecords','s1',90,'{"quotaGroupId":"g1","quotaSlotDocId":"s1","version":2,"indicatorId":"i1","reviewerId":"nurse","submittedBy":"nurse"}')), 'ok');
select test.check('非管理員不能刪紀錄', test.as_user('nurse', test.op('del','reviewRecords','s1',100)), 'err:QA403');

-- ---- 預約鎖（reviewReservations）----
select test.check('只有紀錄沒有預約 → 提交時拒絕', test.as_user('nurse', test.op('set','reviewRecords','rk1',110,'{"uniqueKey":"K1","indicatorId":"i1","reviewerId":"nurse","submittedBy":"nurse"}')), 'err:QA403');
select test.check('預約 ownerId 必須是本人', test.as_user('nurse', test.op('set','reviewReservations','K1',110,'{"uniqueKey":"K1","ownerId":"other","targetCollection":"reviewRecords","targetId":"rk1"}')), 'err:QA403');
select test.check('紀錄＋預約同一批 → 可建立', test.as_user('nurse',
  format('select public.apply_ops(%L::jsonb)', jsonb_build_array(
    jsonb_build_object('kind','set','col','reviewRecords','id','rk1','ts',110,'data','{"uniqueKey":"K1","indicatorId":"i1","reviewerId":"nurse","submittedBy":"nurse"}'::jsonb),
    jsonb_build_object('kind','set','col','reviewReservations','id','K1','ts',110,'data','{"uniqueKey":"K1","ownerId":"nurse","targetCollection":"reviewRecords","targetId":"rk1"}'::jsonb))::text)), 'ok');
select test.check('同一唯一鍵第二次建立（別人）→ 被拒（不會覆蓋別人的預約）', test.as_user('other',
  format('select public.apply_ops(%L::jsonb)', jsonb_build_array(
    jsonb_build_object('kind','set','col','reviewRecords','id','rk2','ts',120,'data','{"uniqueKey":"K1","reviewerId":"other","submittedBy":"other"}'::jsonb),
    jsonb_build_object('kind','set','col','reviewReservations','id','K1','ts',120,'data','{"uniqueKey":"K1","ownerId":"other","targetCollection":"reviewRecords","targetId":"rk2"}'::jsonb))::text)), 'err:QA403');

-- ---- reviewDrafts ----
select test.check('草稿 createdBy 必須是本人', test.as_user('nurse', test.op('set','reviewDrafts','d1',130,'{"createdBy":"other","taskId":"t1"}')), 'err:QA403');
select test.check('本人可建立草稿', test.as_user('nurse', test.op('set','reviewDrafts','d1',130,'{"createdBy":"nurse","taskId":"t1"}')), 'ok');
select test.check('別人不能改草稿', test.as_user('other', test.op('set','reviewDrafts','d1',140,'{"createdBy":"nurse","taskId":"t1","x":1}')), 'err:QA403');
select test.check('管理員可改草稿', test.as_user('admin', test.op('set','reviewDrafts','d1',140,'{"createdBy":"nurse","taskId":"t1","x":1}')), 'ok');

-- ---- 其他 ----
select test.check('召集人類角色可建封存摘要，一般人不行（admin 可）', test.as_user('nurse', test.op('set','reviewArchives','ar1',150,'{}')), 'err:QA403');
select test.check('管理員可建封存摘要', test.as_user('admin', test.op('set','reviewArchives','ar1',150,'{}')), 'ok');
select test.check('無關人員不能建立他人 CAPA', test.as_user('nurse', test.op('set','capa','c1',150,'{"ownerId":"other"}')), 'err:QA403');
select test.check('本人負責 CAPA 可建立', test.as_user('nurse', test.op('set','capa','c2',151,'{"ownerId":"nurse"}')), 'ok');
select test.check('過時的重送略過（不報錯）', test.as_user('admin', test.op('set','systemParams','p2',5,'{"v":"stale"}')), 'ok');
select test.check('過時的重送沒有蓋掉資料', (select data->>'v' from public.docs where col='systemParams' and id='p2'), '2');
select test.check('管理員建立待刪文件', test.as_user('admin', test.op('set','systemParams','tomb1',200,'{"v":"live"}')), 'ok');
select test.check('管理員軟刪文件', test.as_user('admin', test.op('del','systemParams','tomb1',300)), 'ok');
select test.check('舊 set 在 tombstone 後重送不會復活', test.as_user('admin', test.op('set','systemParams','tomb1',250,'{"v":"stale"}')), 'ok');
select test.check('tombstone 不暴露已刪原資料', test.count_as('admin', $$select count(*) from public.docs where col='systemParams' and id='tomb1' and data->>'v'='live'$$), 0::bigint);
select test.check('tombstone 只保留同步標記', (select (deleted and data = '{"_dualTombstone":true,"_dualTs":300}'::jsonb)::text from public.docs where col='systemParams' and id='tomb1'), 'true');
select test.check('新版本合法 set 可復活 tombstone', test.as_user('admin', test.op('set','systemParams','tomb1',400,'{"v":"new"}')), 'ok');
select test.check('復活後為正常文件', (select (not deleted and data->>'v'='new')::text from public.docs where col='systemParams' and id='tomb1'), 'true');
insert into public.docs(col,id,data,ts) values ('reviewSummaries','s9','{"ok":true}',1);   -- 以 postgres（後端／遷移）身分，守門放行
select test.check('後端（postgres／service_role）可寫 reviewSummaries', test.count_as('nurse', $$select count(*) from public.docs where col='reviewSummaries'$$), 1::bigint);


-- ---- db_status（04-status.sql）----
select test.check('管理員可呼叫 db_status', test.as_user('admin', $$select public.db_status()$$), 'ok');
select test.check('非管理員呼叫 db_status 被拒', test.as_user('nurse', $$select public.db_status()$$), 'err:QA403');
select test.check('db_status 回傳資料庫大小', test.count_as('admin', $$select ((public.db_status()->>'dbBytes')::bigint > 0)::int$$), 1::bigint);

-- ---- 報告 ----
select name, case when ok then 'PASS' else 'FAIL' end as result, case when ok then '' else detail end as detail from test.results order by ok, name;
do $$ declare f int; begin select count(*) into f from test.results where not ok; if f > 0 then raise exception '% test(s) failed', f; end if; end $$;
rollback;
