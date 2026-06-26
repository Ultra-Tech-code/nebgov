import path from "path";

export const INDEXER_MIGRATIONS_TABLE = "pgmigrations_nebgov_indexer";

export async function runIndexerMigrations(): Promise<void> {
  if (process.env.NODE_ENV === "test") {
    return;
  }
  const { runner } = await import("node-pg-migrate");
  const databaseUrl =
    process.env.DATABASE_URL ??
    "postgres://nebgov:nebgov@localhost:5432/nebgov";
  await runner({
    databaseUrl,
    dir: path.join(process.cwd(), "migrations"),
    direction: "up",
    migrationsTable: INDEXER_MIGRATIONS_TABLE,
    verbose: process.env.LOG_MIGRATIONS === "1",
  });
}
