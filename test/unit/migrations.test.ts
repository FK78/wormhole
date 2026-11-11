import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  BASELINE_MIGRATION,
  listMigrationNames,
} from "../../src/db/migrations.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "db/migrations");
const FILE_PATTERN = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const UP_MARKER = /^\s*--[\s-]*up\s+migration/im;
const DOWN_MARKER = /^\s*--[\s-]*down\s+migration/im;

const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort();

test("migration filenames use unique, increasing numeric prefixes", () => {
  assert.ok(migrationFiles.length > 0, "expected at least one migration");

  const prefixes = migrationFiles.map((file) => {
    const match = FILE_PATTERN.exec(file);
    assert.ok(match, `unexpected migration filename: ${file}`);
    return Number(match![1]);
  });

  assert.deepEqual(prefixes, [...prefixes].sort((a, b) => a - b));
  assert.equal(new Set(prefixes).size, prefixes.length);
});

test("every migration has non-empty up and down sections", () => {
  for (const file of migrationFiles) {
    const contents = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const up = UP_MARKER.exec(contents);
    const down = DOWN_MARKER.exec(contents);

    assert.ok(up, `${file} is missing the Up Migration marker`);
    assert.ok(down, `${file} is missing the Down Migration marker`);
    assert.ok(up!.index < down!.index, `${file} has Down before Up`);

    const upSql = contents.slice(up!.index + up![0].length, down!.index).trim();
    const downSql = contents.slice(down!.index + down![0].length).trim();

    assert.notEqual(upSql, "", `${file} has an empty Up section`);
    assert.notEqual(downSql, "", `${file} has an empty Down section`);
  }
});

test("the baseline migration is first and listMigrationNames matches the files", () => {
  const names = listMigrationNames();

  assert.equal(names[0], BASELINE_MIGRATION);
  assert.deepEqual(
    names,
    migrationFiles.map((file) => path.basename(file, ".sql")),
  );
});

test("the baseline migration creates and drops the urls table", () => {
  const contents = readFileSync(
    path.join(MIGRATIONS_DIR, `${BASELINE_MIGRATION}.sql`),
    "utf8",
  );

  assert.match(contents, /CREATE TABLE urls/i);
  assert.match(contents, /DROP TABLE urls/i);
});
