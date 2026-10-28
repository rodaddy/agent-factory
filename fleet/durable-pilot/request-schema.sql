-- Explicitly applied only to the isolated request-H database.
CREATE SCHEMA IF NOT EXISTS durable_pi_request;
CREATE TABLE IF NOT EXISTS durable_pi_request.tranches (
  id text PRIMARY KEY,
  max_requests integer NOT NULL CHECK (max_requests BETWEEN 1 AND 6),
  admissions integer NOT NULL DEFAULT 0 CHECK (admissions BETWEEN 0 AND 6),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 6)
);
CREATE TABLE IF NOT EXISTS durable_pi_request.jobs (
  id uuid PRIMARY KEY,
  tranche_id text NOT NULL REFERENCES durable_pi_request.tranches(id),
  request_key text NOT NULL,
  packet jsonb NOT NULL,
  packet_hash text NOT NULL,
  family text NOT NULL CHECK (family IN ('claude','gpt')),
  target_host text CHECK (target_host IN ('107','109','113')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','claimed','started','succeeded','failed','uncertain')),
  claim_token uuid,
  claim_epoch integer NOT NULL DEFAULT 0,
  worker_id text,
  host text CHECK (host IN ('107','109','113')),
  lease_expires_at timestamptz,
  attempt_id uuid,
  result jsonb,
  result_hash text,
  error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (tranche_id,request_key),
  CHECK ((status = 'succeeded') = (result IS NOT NULL AND result_hash IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS durable_pi_request.attempts (
  id uuid PRIMARY KEY,
  tranche_id text NOT NULL REFERENCES durable_pi_request.tranches(id),
  job_id uuid NOT NULL UNIQUE REFERENCES durable_pi_request.jobs(id),
  host text NOT NULL CHECK (host IN ('107','109','113')),
  family text NOT NULL CHECK (family IN ('claude','gpt')),
  claim_token uuid NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tranche_id,host,family)
);
CREATE TABLE IF NOT EXISTS durable_pi_request.outbox (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES durable_pi_request.jobs(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz
);
