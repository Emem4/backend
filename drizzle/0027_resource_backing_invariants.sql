-- #175: enforce the resource type / backing-location invariant in Postgres.
--
-- Valid shapes (see docs/resource-lifecycle.md):
--   staged file    -> resource_type='file', storage_path IS NULL,     external_url IS NULL
--   finalized file -> resource_type='file', storage_path IS NOT NULL, external_url IS NULL
--   link           -> resource_type='link', storage_path IS NULL,     external_url IS NOT NULL
--
-- A file row is inserted in the staged shape and finalized by setting
-- storage_path after the object is written, so the check deliberately allows
-- storage_path IS NULL for file rows. Every statement is idempotent.

-- Preflight: report historical rows that don't match any valid shape before
-- they are normalized below.
DO $$
DECLARE
  file_with_external int;
  link_with_storage int;
  link_without_external int;
  rows_with_both int;
BEGIN
  SELECT count(*) INTO file_with_external
    FROM "resources"
    WHERE "resource_type" = 'file' AND "external_url" IS NOT NULL;
  SELECT count(*) INTO link_with_storage
    FROM "resources"
    WHERE "resource_type" = 'link' AND "storage_path" IS NOT NULL;
  SELECT count(*) INTO link_without_external
    FROM "resources"
    WHERE "resource_type" = 'link' AND "external_url" IS NULL;
  SELECT count(*) INTO rows_with_both
    FROM "resources"
    WHERE "storage_path" IS NOT NULL AND "external_url" IS NOT NULL;

  IF file_with_external > 0 OR link_with_storage > 0
    OR link_without_external > 0 OR rows_with_both > 0 THEN
    RAISE NOTICE '#175 backing-location preflight: normalizing % file rows with external_url, % link rows with storage_path, % link rows without external_url, % rows with both backings',
      file_with_external, link_with_storage, link_without_external, rows_with_both;
  END IF;
END $$;
--> statement-breakpoint

-- Repair impossible legacy rows by trusting whichever backing location exists.
-- When both exist, keep the one matching the declared type. Rows with no
-- backing at all become staged files (the only valid no-backing shape).
UPDATE "resources"
SET "resource_type" = 'link', "storage_path" = NULL
WHERE "resource_type" = 'file'
  AND "external_url" IS NOT NULL
  AND "storage_path" IS NULL;
--> statement-breakpoint
UPDATE "resources"
SET "external_url" = NULL
WHERE "resource_type" = 'file'
  AND "external_url" IS NOT NULL
  AND "storage_path" IS NOT NULL;
--> statement-breakpoint
UPDATE "resources"
SET "resource_type" = 'file', "external_url" = NULL
WHERE "resource_type" = 'link'
  AND "storage_path" IS NOT NULL
  AND "external_url" IS NULL;
--> statement-breakpoint
UPDATE "resources"
SET "storage_path" = NULL
WHERE "resource_type" = 'link'
  AND "storage_path" IS NOT NULL
  AND "external_url" IS NOT NULL;
--> statement-breakpoint
UPDATE "resources"
SET "resource_type" = 'file'
WHERE "resource_type" = 'link'
  AND "storage_path" IS NULL
  AND "external_url" IS NULL;
--> statement-breakpoint

-- Enforce the three valid shapes from now on.
DO $$ BEGIN
  ALTER TABLE "resources" ADD CONSTRAINT "resources_backing_shape_valid" CHECK (
    ("resource_type" = 'file' AND "storage_path" IS NULL AND "external_url" IS NULL)
    OR ("resource_type" = 'file' AND "storage_path" IS NOT NULL AND "external_url" IS NULL)
    OR ("resource_type" = 'link' AND "storage_path" IS NULL AND "external_url" IS NOT NULL)
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;
