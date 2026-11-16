import { readFile } from "node:fs/promises";
import { Pool } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  await pool.query(
    await readFile(
      new URL("../drizzle/0001_pending_settlements.sql", import.meta.url),
      "utf8",
    ),
  );
  process.stdout.write("Facilitator migrations applied.\n");
} finally {
  await pool.end();
}
