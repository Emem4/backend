import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { resources } from "./schema.js";

const dialect = new PgDialect();

const backingCheck = () => {
  const check = getTableConfig(resources).checks.find(
    (item) => item.name === "resources_backing_shape_valid",
  );
  if (!check) throw new Error("resources_backing_shape_valid check is missing");
  return dialect.sqlToQuery(check.value).sql.replace(/\s+/g, " ");
};

describe("resource backing-location invariants (#175)", () => {
  it("declares the three valid shapes in the schema check", () => {
    const sql = backingCheck();

    // Staged file: no backing location yet.
    expect(sql).toContain(
      "resource_type\" = 'file' AND \"resources\".\"storage_path\" IS NULL AND \"resources\".\"external_url\" IS NULL",
    );
    // Finalized file: stored object, no external URL.
    expect(sql).toContain(
      "resource_type\" = 'file' AND \"resources\".\"storage_path\" IS NOT NULL AND \"resources\".\"external_url\" IS NULL",
    );
    // Link: external URL, no stored object.
    expect(sql).toContain(
      "resource_type\" = 'link' AND \"resources\".\"storage_path\" IS NULL AND \"resources\".\"external_url\" IS NOT NULL",
    );
  });

  it("keeps both backing columns nullable for the staged upload transition", () => {
    const columns = new Map(getTableConfig(resources).columns.map((column) => [column.name, column]));

    expect(columns.get("resource_type")?.notNull).toBe(true);
    expect(columns.get("storage_path")?.notNull).toBe(false);
    expect(columns.get("external_url")?.notNull).toBe(false);
  });

  it("ships an idempotent migration and registers it in the drizzle journal", () => {
    const migration = readFileSync(
      new URL("../../drizzle/0027_resource_backing_invariants.sql", import.meta.url),
      "utf8",
    );
    const journal = JSON.parse(
      readFileSync(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8"),
    );

    expect(migration).toContain('ADD CONSTRAINT "resources_backing_shape_valid" CHECK');
    expect(migration).toContain("EXCEPTION WHEN duplicate_object THEN null");
    expect(migration).toContain("UPDATE \"resources\"");
    expect(journal.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tag: "0027_resource_backing_invariants" }),
      ]),
    );
  });
});
