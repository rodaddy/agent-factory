-- #170: record the PROVIDER-ATTESTED model an attempt actually ran on, read from
-- the agent event stream's message_end envelope. Never an agent-authored field:
-- the #110 pilot agent self-reported "ChatGPT" while the server attested
-- "gpt-5.6-sol". Nullable — every pre-#170 row predates the column, and a lane
-- that writes no event stream has no attestation to record. Observational only.
ALTER TABLE "job_attempts" ADD COLUMN "observed_model" text;
