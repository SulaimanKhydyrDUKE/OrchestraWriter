-- Transcription jobs, and the restricted database role the pipeline workers log in as.

CREATE TYPE app.job_status AS ENUM ('queued', 'running', 'succeeded', 'failed');

-- One row per "turn this recording into a score" request. The API creates it,
-- the Step Functions pipeline does the work, the finalize step fills in set_id.
CREATE TABLE app.transcription_jobs (
    id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id       INTEGER        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    audio_file_id INTEGER        REFERENCES app.audio_files(id) ON DELETE SET NULL,
    status        app.job_status NOT NULL DEFAULT 'queued',
    execution_arn TEXT,                       -- Step Functions execution, null when run inline locally
    chunk_count   INTEGER        CHECK (chunk_count > 0),
    set_id        INTEGER        REFERENCES app.orchestral_sets(id) ON DELETE SET NULL,
    error         TEXT,
    created_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ
);

CREATE INDEX ON app.transcription_jobs (user_id, created_at DESC);

-- orchestra_worker: what the pipeline Lambdas log in as (IAM auth, no password).
-- It can read and write music data and job rows, and cannot see the auth schema at all.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orchestra_worker') THEN
    CREATE ROLE orchestra_worker LOGIN;
  END IF;
  -- rds_iam exists only on RDS/Aurora; a local Docker Postgres skips this.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rds_iam') THEN
    GRANT rds_iam TO orchestra_worker;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA app TO orchestra_worker;
GRANT SELECT ON app.instruments, app.audio_files TO orchestra_worker;
GRANT SELECT, INSERT, UPDATE ON app.transcription_jobs, app.orchestral_sets, app.sheets TO orchestra_worker;
