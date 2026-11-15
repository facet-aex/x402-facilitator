import { readFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { Pool } from "pg";

try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  await pool.query(
    await readFile(
      new URL("../drizzle/0001_pending_settlements.sql", import.meta.url),
      "utf8",
    ),
  );
  process.stdout.write("Facilitator pending-settlement migration applied.\n");
} finally {
  await pool.end();
}
