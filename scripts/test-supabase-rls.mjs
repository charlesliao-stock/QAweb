import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sql = async (path) => readFile(resolve(root, path), "utf8");
const db = new PGlite();

try {
  for (const file of [
    "supabase/tests/00-supabase-stub.sql",
    "supabase/01-docs.sql",
    "supabase/02-apply-ops.sql",
    "supabase/03-rls.sql",
    "supabase/04-status.sql",
  ]) {
    await db.exec(await sql(file));
  }

  const testSql = (await sql("supabase/tests/03-rls-test.sql"))
    .replace(/^\\set\s+.*$/gm, "");
  const reportMarker = "-- ---- 報告 ----";
  const reportAt = testSql.indexOf(reportMarker);
  if (reportAt < 0) throw new Error("RLS SQL test report marker not found");
  await db.exec(testSql.slice(0, reportAt));

  const { rows } = await db.query(
    "select name, ok, detail from test.results order by ok, name",
  );
  for (const row of rows) {
    console.log(`${row.ok ? "PASS" : "FAIL"} ${row.name}${row.ok ? "" : ` :: ${row.detail}`}`);
  }
  const failed = rows.filter((row) => !row.ok);
  await db.exec("rollback");
  if (failed.length) throw new Error(`${failed.length} Supabase RLS test(s) failed`);
  console.log(`Supabase RLS tests passed: ${rows.length}`);
} finally {
  await db.close();
}
