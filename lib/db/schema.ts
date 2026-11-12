/**
 * Database schema (PGlite = Postgres in WASM, stored in DATA_DIR).
 * Statements are idempotent and run on every startup; safe because the DB is local and single-process.
 * Tables beyond conversations/messages are created now so later phases add code, not migrations.
 */
export const SCHEMA_SQL = /* sql */ `
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_recent_idx ON conversations (updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('user','assistant')),
  content          text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  timezone         text,
  search           tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
);
-- Citations shown under an assistant answer ([n] -> title, url). Added in phase 3.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS citations jsonb;
-- Insertion order: tie-breaker when timestamps are equal (e.g. AGENT_NOW frozen in demos/tests).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS seq bigserial;

CREATE INDEX IF NOT EXISTS messages_conv_time_idx ON messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS messages_time_idx ON messages (created_at);
CREATE INDEX IF NOT EXISTS messages_search_idx ON messages USING gin (search);

CREATE TABLE IF NOT EXISTS subjects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('vendor','product','plan','other')),
  name        text NOT NULL,
  normalized  text NOT NULL,
  parent_id   uuid REFERENCES subjects(id) ON DELETE CASCADE,
  aliases     text[] NOT NULL DEFAULT '{}',
  UNIQUE NULLS NOT DISTINCT (kind, normalized, parent_id)
);
CREATE INDEX IF NOT EXISTS subjects_trgm_idx ON subjects USING gin (normalized gin_trgm_ops);

CREATE TABLE IF NOT EXISTS sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url           text NOT NULL,
  title         text,
  content       text,
  published_at  timestamptz,
  fetched_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS facts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id     uuid REFERENCES subjects(id) ON DELETE CASCADE,
  attribute      text NOT NULL,
  qualifiers     jsonb NOT NULL DEFAULT '{}'::jsonb,
  value_numeric  numeric,
  value_text     text,
  currency       char(3),
  origin         text NOT NULL CHECK (origin IN ('user_said','assistant_said','web')),
  quote          text NOT NULL,
  message_id     uuid REFERENCES messages(id) ON DELETE CASCADE,
  source_id      uuid REFERENCES sources(id) ON DELETE CASCADE,
  seen_at        timestamptz NOT NULL,
  published_at   timestamptz,
  effective_at   timestamptz,
  CHECK (num_nonnulls(message_id, source_id) = 1),
  CHECK ((origin = 'web') = (source_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS facts_lookup_idx ON facts (subject_id, attribute, seen_at DESC);
-- Phase 4: which conversation a fact came from (deleting the conversation deletes its facts),
-- and de-duplication so retries and repeated extraction never store the same fact twice.
ALTER TABLE facts ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS facts_conversation_idx ON facts (conversation_id);
CREATE UNIQUE INDEX IF NOT EXISTS facts_dedupe_idx
  ON facts (subject_id, attribute, qualifiers, coalesce(value_text, ''), coalesce(source_id, message_id));

CREATE TABLE IF NOT EXISTS search_cache (
  query_key   text PRIMARY KEY,
  results     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage (
  provider  text NOT NULL,
  day       date NOT NULL,
  requests  integer NOT NULL DEFAULT 0,
  tokens    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, day)
);
`;
