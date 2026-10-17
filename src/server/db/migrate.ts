import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getDb, getPool } from "./client";

/** `npm run db:migrate` — applies ./drizzle against DATABASE_URL. */
async function main() {
  const db = getDb();
  await migrate(db, { migrationsFolder: "./drizzle" });
  await getPool().end();
  console.log("Migrations applied.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
