import { getPool, isDbConfigured } from "../src/server/db/client";

/**
 * Read-only production schema review for Growth Program migrations 0019–0021.
 * It never runs migration SQL and never writes to the database.
 */
const expectedTables = [
  "developer_growth_programs",
  "growth_program_participants",
  "growth_attribution_identities",
] as const;

const expectedColumns = [
  ["external_outcome_events", "growth_program_id"],
  ["external_outcome_events", "attribution_identity_id"],
  ["external_outcome_events", "attribution_status"],
  ["developer_growth_programs", "product_url"],
] as const;

const expectedIndexes = [
  "developer_growth_programs_workspace_slug_unique",
  "developer_growth_programs_workspace_idx",
  "developer_growth_programs_campaign_idx",
  "developer_growth_programs_definition_idx",
  "external_outcome_events_program_idx",
  "growth_attribution_identities_code_unique",
  "growth_attribution_identities_program_participant_active_unique",
  "growth_attribution_identities_program_idx",
  "growth_attribution_identities_participant_idx",
  "growth_program_participants_program_idx",
  "growth_program_participants_creator_idx",
  "growth_program_participants_external_idx",
  "growth_program_participants_program_creator_unique",
  "growth_program_participants_program_external_unique",
  "external_outcome_events_attribution_idx",
] as const;

const expectedConstraints = [
  "developer_growth_programs_workspace_id_workspaces_id_fk",
  "developer_growth_programs_campaign_id_campaigns_id_fk",
  "developer_growth_programs_policy_version_id_campaign_policy_versions_id_fk",
  "developer_growth_programs_integration_id_developer_integrations_id_fk",
  "developer_growth_programs_outcome_definition_id_external_outcome_definitions_id_fk",
  "developer_growth_programs_created_by_user_id_users_id_fk",
  "external_outcome_events_growth_program_id_developer_growth_programs_id_fk",
  "growth_attribution_identities_growth_program_id_developer_growth_programs_id_fk",
  "growth_attribution_identities_participant_id_growth_program_participants_id_fk",
  "growth_program_participants_growth_program_id_developer_growth_programs_id_fk",
  "growth_program_participants_creator_user_id_users_id_fk",
  "external_outcome_events_attribution_identity_id_growth_attribution_identities_id_fk",
] as const;

function safeConnectionSummary(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) return "DATABASE_URL=absent";
  try {
    const url = new URL(raw);
    return `host=${url.hostname} database=${(url.pathname || "/").replace(/^\//, "") || "default"}`;
  } catch {
    return "DATABASE_URL=present-non-url";
  }
}

async function main() {
  console.log(`PRODUCTION SCHEMA REVIEW · ${safeConnectionSummary()}`);
  if (!isDbConfigured()) {
    console.log("STATUS: BLOCKED — no production DATABASE_URL is available to this session.");
    console.log("No connection was opened and no SQL was executed.");
    process.exitCode = 2;
    return;
  }

  const pool = getPool();
  try {
    const tables = new Set<string>((await pool.query<{ relname: string }>(
      `SELECT c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r','p')`,
    )).rows.map((row) => row.relname));
    const columns = new Map<string, { data_type: string; is_nullable: string; column_default: string | null }>();
    for (const row of (await pool.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND ((table_name = 'external_outcome_events' AND column_name IN ('growth_program_id','attribution_identity_id','attribution_status')) OR (table_name = 'developer_growth_programs' AND column_name = 'product_url'))`,
    )).rows) {
      columns.set(`${row.table_name}.${row.column_name}`, row);
    }
    const indexes = new Set<string>((await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'",
    )).rows.map((row) => row.indexname));
    const constraints = new Set<string>((await pool.query<{ conname: string }>(
      `SELECT conname
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = 'public'`,
    )).rows.map((row) => row.conname));

    const missing: string[] = [];
    const present: string[] = [];
    const conflicting: string[] = [];
    for (const table of expectedTables) (tables.has(table) ? present : missing).push(`table ${table}`);
    for (const [table, column] of expectedColumns) {
      const key = `${table}.${column}`;
      const row = columns.get(key);
      if (!row) missing.push(`column ${key}`);
      else if (column === "attribution_status" && (row.data_type !== "text" || row.is_nullable !== "NO")) conflicting.push(`column ${key} type=${row.data_type} nullable=${row.is_nullable}`);
      else present.push(`column ${key}`);
    }
    for (const index of expectedIndexes) (indexes.has(index) ? present : missing).push(`index ${index}`);
    for (const constraint of expectedConstraints) (constraints.has(constraint) ? present : missing).push(`constraint ${constraint}`);

    console.log(`MISSING (${missing.length}):`);
    for (const item of missing) console.log(`- ${item}`);
    console.log(`ALREADY_PRESENT (${present.length}):`);
    for (const item of present) console.log(`- ${item}`);
    console.log(`CONFLICTING (${conflicting.length}):`);
    for (const item of conflicting) console.log(`- ${item}`);
    console.log(`RECOMMENDATION: ${conflicting.length ? "NEEDS_ADJUSTMENT" : "SAFE_TO_REVIEW_FOR_MANUAL_APPLICATION"}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Schema review failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
