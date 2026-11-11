-- Test-only migration: exercises the forward and rollback path against a
-- database that was baselined from the pre-migration schema. It is never
-- loaded from db/migrations.

-- Up Migration
ALTER TABLE urls ADD COLUMN test_marker TEXT;

-- Down Migration
ALTER TABLE urls DROP COLUMN test_marker;
