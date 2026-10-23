-- Split identity data from music data.
--   auth: users, sessions, accounts, verifications   (Better Auth; only the API may touch it)
--   app:  everything else                             (API and pipeline workers)
-- Foreign keys from app tables to auth.users keep working across schemas,
-- so deleting a user still cascades to their recordings and scores.

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS app;

ALTER TABLE public.users         SET SCHEMA auth;
ALTER TABLE public.sessions      SET SCHEMA auth;
ALTER TABLE public.accounts      SET SCHEMA auth;
ALTER TABLE public.verifications SET SCHEMA auth;

ALTER TYPE  public.instrument_family      SET SCHEMA app;
ALTER TABLE public.instruments            SET SCHEMA app;
ALTER TABLE public.audio_files            SET SCHEMA app;
ALTER TABLE public.audio_file_instruments SET SCHEMA app;
ALTER TABLE public.orchestral_sets        SET SCHEMA app;
ALTER TABLE public.sheets                 SET SCHEMA app;

-- Unqualified names (users, audio_files, ...) resolve app first, then auth.
-- Set on the database so every role and every new connection gets it, including
-- connections from code that predates this migration. The pool also sets it.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path = app, auth, public', current_database());
END
$$;
SET LOCAL search_path = app, auth, public;
