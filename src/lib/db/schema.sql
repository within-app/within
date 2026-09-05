-- ============================================================
-- Journal App — PostgreSQL Schema
-- PostgreSQL 13+ (gen_random_uuid() built-in, no extension needed)
-- ============================================================

CREATE TABLE IF NOT EXISTS journals (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  color       TEXT        NOT NULL DEFAULT '#007AFF',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tags (
  id    UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  name  TEXT  NOT NULL,
  CONSTRAINT tags_name_unique UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS entries (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_id            UUID        NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
  text                  TEXT        NOT NULL DEFAULT '',
  created_at            TIMESTAMPTZ NOT NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  starred               BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Location
  location_name         TEXT,
  location_lat          DOUBLE PRECISION,
  location_lng          DOUBLE PRECISION,
  -- Weather
  weather_description   TEXT,
  weather_temp_celsius  INTEGER,
  weather_icon          TEXT
);

CREATE TABLE IF NOT EXISTS media (
  id               UUID     PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id         UUID     NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  type             TEXT     NOT NULL CHECK (type IN ('photo', 'audio', 'video')),
  file_path        TEXT     NOT NULL,
  thumbnail_path   TEXT,
  order_index      INTEGER  NOT NULL DEFAULT 0,
  duration_seconds INTEGER
);

CREATE TABLE IF NOT EXISTS entry_tags (
  entry_id  UUID NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  tag_id    UUID NOT NULL REFERENCES tags(id)    ON DELETE CASCADE,
  PRIMARY KEY (entry_id, tag_id)
);

-- ============================================================
-- Indexes
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_entries_journal_id        ON entries(journal_id);
CREATE INDEX IF NOT EXISTS idx_entries_created_at        ON entries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_journal_created   ON entries(journal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_entry_id            ON media(entry_id);
CREATE INDEX IF NOT EXISTS idx_media_entry_type_order    ON media(entry_id, type, order_index);
CREATE INDEX IF NOT EXISTS idx_entry_tags_entry_id       ON entry_tags(entry_id);
CREATE INDEX IF NOT EXISTS idx_entry_tags_tag_id         ON entry_tags(tag_id);

-- Full-text search index
CREATE INDEX IF NOT EXISTS idx_entries_fts ON entries USING gin(to_tsvector('german', text));

-- ============================================================
-- Add preview_path (animated loop-clip) to media
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'media' AND column_name = 'preview_path'
  ) THEN
    ALTER TABLE media ADD COLUMN preview_path TEXT;
  END IF;
END $$;

-- ============================================================
-- Offline sync
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'entries' AND column_name = 'revision_id'
  ) THEN
    ALTER TABLE entries ADD COLUMN revision_id UUID NOT NULL DEFAULT gen_random_uuid();
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_entries_updated_at ON entries(updated_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS sync_conflict_copies (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id      UUID        NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  revision_id   UUID        NOT NULL,
  text          TEXT        NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL,
  starred       BOOLEAN     NOT NULL DEFAULT FALSE,
  location_name TEXT,
  location_lat  DOUBLE PRECISION,
  location_lng  DOUBLE PRECISION,
  tags          TEXT[]      NOT NULL DEFAULT '{}',
  saved_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_conflict_copies_entry_id
  ON sync_conflict_copies(entry_id);

-- ============================================================
-- Soft-delete tombstones
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'entries' AND column_name = 'deleted_at'
  ) THEN
    ALTER TABLE entries ADD COLUMN deleted_at TIMESTAMPTZ;
  END IF;
END $$;

-- Partial index for tombstone sync feed (getChangesSince includes deleted entries)
CREATE INDEX IF NOT EXISTS idx_entries_deleted_at
  ON entries(deleted_at)
  WHERE deleted_at IS NOT NULL;

-- ============================================================
-- 20260711_000000 — missing indexes
-- ============================================================

-- Trigram extension for leading-wildcard LIKE on location_name
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Partial index covering geo-filtered map query and its sort
CREATE INDEX IF NOT EXISTS idx_entries_geo
  ON entries(journal_id, created_at DESC)
  WHERE location_lat IS NOT NULL AND location_lng IS NOT NULL;

-- Superseded (timezone handling changed): month_day_utc() war an UTC gebunden.
-- Die Zonen-Variante hängt von der konfigurierten Zone ab (STABLE, nicht
-- IMMUTABLE) und ist damit kein zulässiger Ausdruck für einen funktionalen
-- Index mehr — Index und alte Funktion fallen weg, idempotent per IF EXISTS.
DROP INDEX IF EXISTS idx_entries_month_day;
DROP FUNCTION IF EXISTS month_day_utc(TIMESTAMPTZ);

-- deliberate simplification: Ein-Personen-Tabelle, Seq-Scan über MM-DD reicht; Upgrade-Pfad
-- wäre ein Index pro konfigurierter Zone.
CREATE OR REPLACE FUNCTION month_day_in(ts TIMESTAMPTZ, tz TEXT)
  RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT TO_CHAR(ts AT TIME ZONE tz, 'MM-DD')
$$;

-- gin/trgm index for leading-wildcard LIKE on location_name
CREATE INDEX IF NOT EXISTS idx_entries_location_name_trgm
  ON entries USING gin (location_name gin_trgm_ops);

-- ============================================================
-- backup_runs: restore-verification audit trail
-- ============================================================

CREATE TABLE IF NOT EXISTS backup_runs (
  id                  SERIAL      PRIMARY KEY,
  run_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status              TEXT        NOT NULL CHECK (status IN ('ok', 'error')),
  backup_file         TEXT,
  live_entry_count    INTEGER,
  verify_entry_count  INTEGER,
  live_media_count    INTEGER,
  verify_media_count  INTEGER,
  error_msg           TEXT
);

-- ============================================================
-- 20260727_000000 — idempotente Media-Uploads
-- ============================================================
-- Ein Upload-Retry nach verlorener Antwort (Funkloch, App-Kill zwischen
-- Response und Outbox-Delete) darf keine zweite media-Zeile erzeugen. Der
-- Client schickt die Outbox-Id als client_media_id mit; UNIQUE macht den
-- Retry serverseitig erkennbar. Additiv, kein Backfill nötig — Alt-Zeilen
-- bleiben NULL und der partielle Index lässt beliebig viele NULLs zu.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'media' AND column_name = 'client_media_id'
  ) THEN
    ALTER TABLE media ADD COLUMN client_media_id TEXT;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_media_client_media_id
  ON media(client_media_id)
  WHERE client_media_id IS NOT NULL;

-- ============================================================
-- 20260805_000000 — i18n: globale App-Einstellungen (Key-Value)
-- ============================================================
-- Single-User-App: eine Zeile pro Einstellung. Erster Nutzer ist die
-- UI-Sprache (key = 'locale'); künftige Einstellungen nutzen dieselbe Tabelle.

CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT        PRIMARY KEY,
  value       TEXT        NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 20260823_003121 — Pin-Sync: pinned_at auf entries
-- ============================================================
-- Pins werden geräteübergreifend gesynct. pinned_at ist Metadatum: der
-- Pin-Endpoint bumpt updated_at (damit die Änderung im Sync-Feed reist),
-- aber NIE revision_id — ein revision-Bump würde für parallele Text-Edits
-- Konfliktkopien fabrizieren. NULL = nicht gepinnt. Additiv, kein Backfill:
-- Bestands-Pins der Geräte meldet der Client beim ersten Sync selbst hoch
-- (Union-Fail-safe, pin-ops.ts).

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'entries' AND column_name = 'pinned_at'
  ) THEN
    ALTER TABLE entries ADD COLUMN pinned_at TIMESTAMPTZ;
  END IF;
END $$;

-- ============================================================
-- 20260822_000000 — Tombstone-Hygiene
-- ============================================================
-- Alt-Tombstones trugen den kompletten Eintragstext (+ Ort/Wetter) und ihre
-- Konfliktkopien blieben liegen (Soft-Delete feuert kein CASCADE). Idempotent:
-- nach dem ersten Lauf treffen die WHERE-Klauseln nichts mehr.

UPDATE entries
   SET text = '', location_name = NULL, location_lat = NULL, location_lng = NULL,
       weather_description = NULL, weather_temp_celsius = NULL, weather_icon = NULL
 WHERE deleted_at IS NOT NULL
   AND (text <> '' OR location_name IS NOT NULL OR weather_description IS NOT NULL);

DELETE FROM sync_conflict_copies scc
 USING entries e
 WHERE scc.entry_id = e.id
   AND e.deleted_at IS NOT NULL;

-- ============================================================
-- 20260903_000000 — Waisen-Tags
-- ============================================================
-- Bis dahin löschte keine Unlink-Stelle die tags-Zeile: Namen gelöschter
-- Einträge blieben in DB und jedem pg_dump. Der Schreibpfad räumt jetzt nach
-- jedem COMMIT, ein fail-soft Sweep beim Start und täglich holt nach
-- (src/lib/db/tags.ts) — bewusst nicht hier: ein Sperr-Fehler wäre ein
-- fataler Migrationsfehler. Hier nur die einmalige Reparatur: Verknüpfungen
-- an Tombstones aus der nicht-transaktionalen DELETE-Phase lösen, sonst hält
-- ihr Tag den Namen für immer.
-- Idempotent — trifft nach dem ersten Lauf nichts mehr.

DELETE FROM entry_tags et
 USING entries e
 WHERE et.entry_id = e.id
   AND e.deleted_at IS NOT NULL;
