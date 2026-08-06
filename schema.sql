-- Ember — maintenance intelligence
-- Optional Supabase backing store. The application works entirely offline
-- against localStorage; run this only if you want the log synced across
-- devices.
--
-- Run in the Supabase SQL editor, then create config.js as described in
-- src/data/supabaseAdapter.js.

-- =========================================================
-- STATE TABLE
-- =========================================================
-- The whole database is stored as one JSONB document per profile.
--
-- That is an unusual choice and worth justifying: the analytics layer reads
-- the entire history on every recomputation (the Kalman filter is sequential
-- over all days, and the ridge fit needs every row), so there is no query
-- pattern that a normalised schema would serve better. A single document also
-- means schema migrations happen in migrate() in JavaScript, in one place,
-- rather than as coordinated SQL and client changes.
--
-- If the log ever grows past a few thousand days, or multiple clients start
-- writing concurrently, split `days` into its own table — the storage adapter
-- interface in src/data/store.js is the seam for exactly that change.

create table if not exists public.tdee_state (
  profile_id  text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists tdee_state_updated_at_idx
  on public.tdee_state (updated_at desc);

-- =========================================================
-- ROW LEVEL SECURITY
-- =========================================================
-- Matching the pattern used by the other trackers in this repo: no Supabase
-- Auth, profiles identified by a short text id, anon role permitted.
--
-- READ THIS BEFORE USING IT: with these policies, anyone holding the anon key
-- and a profile id can read and overwrite that profile's data. That is an
-- acceptable trade for a private single-user tracker on an unguessable URL. It
-- is NOT acceptable if the log is sensitive to you. For a stricter setup, turn
-- on Supabase Auth and replace the policies below with
--   using (auth.uid() = user_id)
-- plus a user_id uuid column referencing auth.users.

alter table public.tdee_state enable row level security;

drop policy if exists "anon read tdee_state"   on public.tdee_state;
drop policy if exists "anon insert tdee_state" on public.tdee_state;
drop policy if exists "anon update tdee_state" on public.tdee_state;
drop policy if exists "anon delete tdee_state" on public.tdee_state;

create policy "anon read tdee_state"
  on public.tdee_state for select
  to anon using (true);

create policy "anon insert tdee_state"
  on public.tdee_state for insert
  to anon with check (true);

create policy "anon update tdee_state"
  on public.tdee_state for update
  to anon using (true) with check (true);

create policy "anon delete tdee_state"
  on public.tdee_state for delete
  to anon using (true);

-- =========================================================
-- UPDATED_AT TRIGGER
-- =========================================================

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tdee_state_touch on public.tdee_state;
create trigger tdee_state_touch
  before update on public.tdee_state
  for each row execute function public.touch_updated_at();
