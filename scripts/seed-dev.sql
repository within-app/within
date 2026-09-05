-- Synthetic seed data for the local dev/self-test stack.
-- Loaded at DB init time by docker-compose.dev.yml via postgres init-scripts.
-- NO real journal content — all entries are synthetic test data.
--
-- Journal IDs are deterministic so Playwright tests can reference them directly.

INSERT INTO journals (id, name, color, created_at) VALUES
  ('10000000-0000-4000-8000-000000000001', 'Dev Journal',  '#007AFF', '2026-01-01 00:00:00+00'),
  ('10000000-0000-4000-8000-000000000002', 'Test Journal', '#34C759', '2026-01-02 00:00:00+00')
ON CONFLICT DO NOTHING;

INSERT INTO entries (id, journal_id, text, created_at, updated_at, starred)
VALUES
  ('20000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000001',
   'Synthetic entry A — dev seed data',
   '2026-01-10 09:00:00+00', '2026-01-10 09:00:00+00', false),
  ('20000000-0000-4000-8000-000000000002',
   '10000000-0000-4000-8000-000000000001',
   'Synthetic entry B — dev seed data',
   '2026-02-14 14:30:00+00', '2026-02-14 14:30:00+00', true),
  ('20000000-0000-4000-8000-000000000003',
   '10000000-0000-4000-8000-000000000001',
   'Synthetic entry C — dev seed data',
   '2026-03-20 18:15:00+00', '2026-03-20 18:15:00+00', false),
  ('20000000-0000-4000-8000-000000000004',
   '10000000-0000-4000-8000-000000000002',
   'Synthetic entry D — dev seed data (Test Journal)',
   '2026-04-05 07:45:00+00', '2026-04-05 07:45:00+00', false),
  ('20000000-0000-4000-8000-000000000005',
   '10000000-0000-4000-8000-000000000001',
   'Synthetic entry E — dev seed data',
   '2026-05-22 11:00:00+00', '2026-05-22 11:00:00+00', true)
ON CONFLICT DO NOTHING;
