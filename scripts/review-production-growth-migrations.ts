import { getPool, isDbConfigured } from "../src/server/db/client";

/**
 * Read-only production schema review for the shipped Outcome API and Growth
 * Program migrations 0018–0021. It never runs migration SQL and never writes
 * to the database.
 */
const prerequisiteTables = [
  "workspaces",
  "campaigns",
  "campaign_policy_versions",
  "users",
] as const;

const expectedTableColumns = {
  developer_integrations: [
    "id",
    "workspace_id",
    "name",
    "status",
    "api_key_id",
    "api_key_prefix",
    "api_key_digest",
    "created_at",
    "revoked_at",
    "last_used_at",
  ],
  external_outcome_definitions: [
    "id",
    "workspace_id",
    "slug",
    "name",
    "description",
    "outcome_type",
    "unit_value_micro_usdc",
    "asset",
    "evidence_schema_version",
    "evidence_schema_json",
    "verification_policy_id",
    "hold_seconds",
    "active",
    "used_at",
    "created_at",
    "updated_at",
  ],
  external_outcome_events: [
    "id",
    "receipt_id",
    "workspace_id",
    "integration_id",
    "definition_id",
    "external_event_id",
    "external_subject_id",
    "occurred_at",
    "schema_version",
    "evidence_json",
    "normalized_evidence_json",
    "evidence_hash",
    "idempotency_key",
    "request_fingerprint",
    "verification_state",
    "hold_state",
    "settlement_state",
    "execution_state",
    "decision_reasons_json",
    "policy_snapshot_json",
    "procurement_recommendation",
    "rejection_code",
    "hold_until",
    "verified_at",
    "settled_at",
    "created_at",
    "updated_at",
  ],
  developer_growth_programs: [
    "id",
    "workspace_id",
    "campaign_id",
    "policy_version_id",
    "integration_id",
    "outcome_definition_id",
    "name",
    "slug",
    "objective_outcome_type",
    "max_verified_cac_micro_usdc",
    "participant_types",
    "reward_structure",
    "operator_mode",
    "status",
    "participation_status",
    "attribution_status",
    "created_by_user_id",
    "created_at",
    "updated_at",
    "product_url",
  ],
  growth_program_participants: [
    "id",
    "growth_program_id",
    "participant_type",
    "creator_user_id",
    "external_partner_id",
    "display_name",
    "handle",
    "status",
    "participation_source",
    "reward_policy_snapshot_json",
    "joined_at",
    "approved_at",
    "created_at",
    "updated_at",
  ],
  growth_attribution_identities: [
    "id",
    "growth_program_id",
    "participant_id",
    "public_code",
    "status",
    "created_at",
    "revoked_at",
  ],
} as const;

const expectedTables = Object.keys(expectedTableColumns) as Array<keyof typeof expectedTableColumns>;

const expectedAddedColumns = [
  ["external_outcome_events", "growth_program_id"],
  ["external_outcome_events", "attribution_identity_id"],
  ["external_outcome_events", "attribution_status"],
  ["developer_growth_programs", "product_url"],
] as const;

const expectedIndexes = [
  "developer_integrations_workspace_idx",
  "external_outcome_definitions_workspace_slug_version_unique",
  "external_outcome_definitions_workspace_slug_idx",
  "external_outcome_events_workspace_event_unique",
  "external_outcome_events_workspace_definition_idempotency_unique",
  "external_outcome_events_workspace_idx",
  "external_outcome_events_integration_idx",
  "external_outcome_events_definition_idx",
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
  "developer_integrations_api_key_id_unique",
  "developer_integrations_api_key_digest_unique",
  "developer_integrations_status_check",
  "external_outcome_definitions_value_check",
  "external_outcome_definitions_hold_check",
  "external_outcome_events_receipt_id_unique",
  "external_outcome_events_verification_state_check",
  "external_outcome_events_hold_state_check",
  "external_outcome_events_settlement_state_check",
  "developer_integrations_workspace_id_workspaces_id_fk",
  "external_outcome_definitions_workspace_id_workspaces_id_fk",
  "external_outcome_events_workspace_id_workspaces_id_fk",
  "external_outcome_events_integration_id_developer_integrations_id_fk",
  "external_outcome_events_definition_id_external_outcome_definitions_id_fk",
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
  "external_outcome_events_attribution_status_check",
] as const;

function findPostgresIdentifier(actual: Set<string>, expected: string): string | null {
  const candidates = [expected, expected.slice(0, 63)];
  return candidates.find((candidate) => actual.has(candidate)) ?? null;
}

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
  console.log(`PRODUCTION SCHEMA REVIEW · migrations=0018,0019,0020,0021 · ${safeConnectionSummary()}`);
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
    const columnNames = new Map<string, Set<string>>();
    for (const row of (await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [expectedTables],
    )).rows) {
      const columns = columnNames.get(row.table_name) ?? new Set<string>();
      columns.add(row.column_name);
      columnNames.set(row.table_name, columns);
    }
    const columns = new Map<string, { data_type: string; is_nullable: string; column_default: string | null }>();
    for (const row of (await pool.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND ((table_name = 'external_outcome_events' AND column_name IN ('growth_program_id','attribution_identity_id','attribution_status'))
           OR (table_name = 'developer_growth_programs' AND column_name = 'product_url'))`,
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
    const partial: string[] = [];
    const conflicting: string[] = [];
    const missingPrerequisites = prerequisiteTables.filter((table) => !tables.has(table));

    for (const table of expectedTables) {
      if (!tables.has(table)) {
        missing.push(`table ${table}`);
        continue;
      }
      const missingColumns = expectedTableColumns[table].filter((column) => !columnNames.get(table)?.has(column));
      if (missingColumns.length) partial.push(`table ${table} missing columns=${missingColumns.join(",")}`);
      else present.push(`table ${table}`);
    }
    for (const [table, column] of expectedAddedColumns) {
      const key = `${table}.${column}`;
      const row = columns.get(key);
      if (!row) missing.push(`column ${key}`);
      else if (column === "attribution_status" && (row.data_type !== "text" || row.is_nullable !== "NO")) conflicting.push(`column ${key} type=${row.data_type} nullable=${row.is_nullable}`);
      else present.push(`column ${key}`);
    }
    for (const index of expectedIndexes) {
      const actual = findPostgresIdentifier(indexes, index);
      (actual ? present : missing).push(actual && actual !== index ? `index ${index} (actual=${actual})` : `index ${index}`);
    }
    for (const constraint of expectedConstraints) {
      const actual = findPostgresIdentifier(constraints, constraint);
      (actual ? present : missing).push(actual && actual !== constraint ? `constraint ${constraint} (actual=${actual})` : `constraint ${constraint}`);
    }

    console.log(`MISSING (${missing.length}):`);
    for (const item of missing) console.log(`- ${item}`);
    console.log(`ALREADY_PRESENT (${present.length}):`);
    for (const item of present) console.log(`- ${item}`);
    console.log(`PARTIAL (${partial.length}):`);
    for (const item of partial) console.log(`- ${item}`);
    console.log(`CONFLICTING (${conflicting.length}):`);
    for (const item of conflicting) console.log(`- ${item}`);
    console.log(`MISSING_PREREQUISITES (${missingPrerequisites.length}):`);
    for (const item of missingPrerequisites) console.log(`- table ${item}`);
    const recommendation = conflicting.length
      ? "NEEDS_ADJUSTMENT"
      : missingPrerequisites.length
        ? "BLOCKED_MISSING_PREREQUISITES"
        : missing.length || partial.length
          ? "SAFE_TO_REVIEW_FOR_MANUAL_APPLICATION"
          : "PRESENT_AND_VERIFIED";
    console.log(`RECOMMENDATION: ${recommendation}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Schema review failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
