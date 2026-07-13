-- Blindspot cache + blocklist schema.
--
-- WHY THIS FILE EXISTS: the app (src/lib/supabase.ts) talks to a custom "blindspot"
-- schema, and scripts/migrate-caches.mjs only UPSERTS data — it never creates the tables.
-- This is the missing DDL. Run it ONCE per Supabase project.
--
-- HOW TO APPLY (the anon/publishable key can't run DDL — this needs admin):
--   1. Supabase Dashboard → SQL Editor → paste this whole file → Run.
--   2. Dashboard → Project Settings → API → "Exposed schemas" → add `blindspot` → Save.
--      (PostgREST only exposes `public`/`graphql_public` by default; without this the JS
--       client gets PGRST106 "schema must be one of…" and every cache call falls back to
--       uncached.)
--   3. Verify: `npm run smoke:supabase`

create schema if not exists blindspot;

-- Key/value cache for Firecrawl search + scrape results.
-- upsert target is (type, key); value is the cached payload (search hits array, or {content}).
create table if not exists blindspot.cache (
  type       text not null check (type in ('search', 'scrape')),  -- only the two real kinds
  key        text not null,               -- query string, or normalized url
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (type, key)
);

-- Domains known to block scraping (seeded + learned via recordBlock()).
create table if not exists blindspot.blocklist (
  domain   text primary key,
  reason   text,
  added_at timestamptz not null default now()
);

-- Table-level privileges: the app reaches these through PostgREST as the `anon` role
-- (the publishable/anon key). Grant it access; default privileges cover future tables.
grant usage on schema blindspot to anon, authenticated, service_role;
grant all on all tables in schema blindspot to anon, authenticated, service_role;
alter default privileges in schema blindspot
  grant all on tables to anon, authenticated, service_role;

-- RLS: this is a shared, non-sensitive cache, so allow the anon key full read/write.
alter table blindspot.cache     enable row level security;
alter table blindspot.blocklist enable row level security;

drop policy if exists "cache anon rw"     on blindspot.cache;
drop policy if exists "blocklist anon rw" on blindspot.blocklist;

create policy "cache anon rw" on blindspot.cache
  for all to anon, authenticated using (true) with check (true);
create policy "blocklist anon rw" on blindspot.blocklist
  for all to anon, authenticated using (true) with check (true);
