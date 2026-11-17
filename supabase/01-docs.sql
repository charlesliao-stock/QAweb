-- Supabase side: generic document table that mirrors Firestore documents 1:1.
-- (If you prefer per-collection relational tables, keep the same three columns: ts, deleted, data.)

create table if not exists public.docs (
  col     text    not null,               -- Firestore collection name
  id      text    not null,               -- Firestore document id
  data    jsonb   not null,               -- full document body
  ts      bigint  not null,               -- last-write-wins clock (ms), same value as data._ts
  deleted boolean not null default false, -- tombstone
  primary key (col, id)
);
create index if not exists docs_col_ts on public.docs (col, ts);

-- Conditional upsert: stale / replayed writes become no-ops, so queue replays are idempotent.
create or replace function public.upsert_doc(p_col text, p_id text, p_doc jsonb)
returns boolean
language plpgsql
as $$
declare n int;
begin
  insert into public.docs (col, id, data, ts, deleted)
  values (p_col, p_id, p_doc, (p_doc->>'_ts')::bigint, coalesce((p_doc->>'deleted')::boolean, false))
  on conflict (col, id) do update
    set data = excluded.data, ts = excluded.ts, deleted = excluded.deleted
    where public.docs.ts <= excluded.ts;
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- RLS: turn it on and write policies that match your Firebase security rules / roles.
alter table public.docs enable row level security;
-- example (authenticated users only; tighten per collection before production):
-- create policy docs_rw on public.docs for all to authenticated using (true) with check (true);
