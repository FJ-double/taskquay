import type Database from "better-sqlite3";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";
import { migrateProjectConsole } from "../project-console-schema.js";

interface Migration {
  version: number;
  name: string;
  up(sqlite: Database.Database): void;
}

const migrations: Migration[] = [
  // New versions are appended below; existing migrations remain immutable.
  {
    version: 1,
    name: "workspace-state",
    up: migrateWorkspaceState,
  },
  {
    version: 2,
    name: "oauth-state",
    up: migrateOAuthState,
  },
  {
    version: 3,
    name: "local-agent-sessions",
    up: migrateLocalAgentSessions,
  },
  {
    version: 4,
    name: "workspace-conversation-bindings",
    up: migrateWorkspaceConversationBindings,
  },
  {
    version: 5,
    name: "local-agent-structured-errors",
    up: migrateLocalAgentStructuredErrors,
  },
  {
    version: 6,
    name: "local-agent-effort-rename",
    up: migrateLocalAgentEffortRename,
  },
  {
    version: 7,
    name: "execution-coordination",
    up(sqlite) {
      sqlite.exec(`create table if not exists execution_claims (
        id text primary key,
        owner_id text not null,
        owner_pid integer not null,
        kind text not null,
        checkout_root text not null,
        agent_id text,
        resources text not null,
        acquired_at text not null
      );`);
    },
  },
  {
    version: 8,
    name: "idempotent-agent-task-identity",
    up(sqlite) {
      sqlite.exec(`create table if not exists agent_task_keys (
        workspace_root text not null, workspace_scope text not null,
        target text not null, task_key text not null, request_hash text not null,
        agent_id text not null references local_agent_sessions(id),
        primary key (workspace_root, workspace_scope, target, task_key)
      );`);
    },
  },
  {
    version: 9,
    name: "provider-usage-snapshots",
    up(sqlite) {
      sqlite.exec(`create table if not exists agent_usage_snapshots (
        agent_id text not null references local_agent_sessions(id),
        thread_id text not null, turn_id text not null,
        total_tokens integer not null, totals text not null, last_request text,
        baseline text, baseline_kind text not null, observed_at text not null,
        provider_version text,
        primary key (agent_id, thread_id, turn_id)
      );`);
    },
  },
];

migrations.push({
  version: 10,
  name: "bounded-read-admission-and-context-affinity",
  up(sqlite) {
    // A legacy claim has unknown effects and remains exclusive after upgrade.
    addColumnIfMissing(sqlite, "execution_claims", "access_mode", "text not null default 'write'");
    addColumnIfMissing(sqlite, "execution_claims", "thread_key", "text");
    addColumnIfMissing(sqlite, "local_agent_sessions", "context_key", "text");
    addColumnIfMissing(sqlite, "local_agent_sessions", "context_signature", "text");
    addColumnIfMissing(sqlite, "local_agent_sessions", "work_item_id", "text");
    sqlite.exec(`
      create table execution_waiters (
        sequence integer primary key autoincrement,
        id text not null unique,
        owner_id text not null,
        owner_pid integer not null,
        kind text not null,
        checkout_root text not null,
        agent_id text,
        thread_key text,
        access_mode text not null,
        resources text not null,
        expires_at_ms integer not null
      );
      create index execution_waiters_order on execution_waiters(sequence);
      create table agent_continue_keys (
        agent_id text not null references local_agent_sessions(id) on delete cascade,
        request_key text not null,
        request_hash text not null,
        primary key(agent_id, request_key)
      );
      create index agent_context_affinity on local_agent_sessions
        (workspace_root, workspace_id, profile_name, work_item_id, context_key, context_signature);
    `);
  },
});

export function migrateDatabase(sqlite: Database.Database): void {
  const migrate = sqlite.transaction(() => {
    sqlite.exec(`
      create table if not exists devspace_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
    `);

    const appliedRows = sqlite
      .prepare("select version, name from devspace_schema_migrations order by version")
      .all() as Array<{ version: number; name: string }>;
    const migrationsByVersion = new Map(migrations.map((migration) => [migration.version, migration]));
    for (const row of appliedRows) {
      const expected = migrationsByVersion.get(row.version);
      if (!expected) {
        throw new Error(
          `Database migration history is incompatible: version ${row.version} (${JSON.stringify(row.name)}) is unknown to this build.`,
        );
      }
      if (row.name !== expected.name) {
        throw new Error(
          `Database migration history is incompatible: version ${row.version} is recorded as ${JSON.stringify(row.name)}, but this build expects ${JSON.stringify(expected.name)}.`,
        );
      }
    }
    const applied = new Set(appliedRows.map((row) => row.version));
    const recordMigration = sqlite.prepare(
      "insert into devspace_schema_migrations (version, name, applied_at) values (?, ?, ?)",
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      migration.up(sqlite);
      recordMigration.run(migration.version, migration.name, new Date().toISOString());
    }
  });

  migrate.immediate();
}

/**
 * Disposable schema-v17 source builder for migration rehearsal ONLY.
 * Never call this from the production database opener. Its safety
 * boundaries are deliberately separate from migrateDatabase().
 */
export function createTestOnlyVersion17Fixture(sqlite: Database.Database): void {
  if(process.env.TASKQUAY_SQLITE_SHADOW_REHEARSAL!=="1") {
    throw new Error("SQLITE_V17_FIXTURE_EXPLICIT_TEST_GATE_REQUIRED");
  }
  // The fixture may never initialize a real Taskquay DB, even if an
  // operator accidentally sets the test environment switch.
  const parent=realpathSync(dirname(sqlite.name));
  const temp=realpathSync(tmpdir());
  if(!parent.toLowerCase().startsWith((temp+sep).toLowerCase()) ||
     !basename(parent).startsWith("taskquay-sqlite-shadow-") ||
     !/^v17-source-[a-z0-9-]+\.sqlite$/i.test(basename(sqlite.name)) ||
     resolve(sqlite.name).toLowerCase()!==sqlite.name.toLowerCase()) {
    throw new Error("SQLITE_V17_FIXTURE_TEMP_SOURCE_ONLY");
  }
  const start=sqlite.prepare("select count(*) as n from sqlite_master where type='table'").get() as {n:number};
  if(start.n!==0)throw new Error("SQLITE_V17_FIXTURE_MUST_START_EMPTY");
  const run=sqlite.transaction(()=>{
    sqlite.exec(`create table devspace_schema_migrations (
      version integer primary key, name text not null, applied_at text not null
    );`);
    const record=sqlite.prepare("insert into devspace_schema_migrations (version,name,applied_at) values(?,?,?)");
    for(const migration of migrations){
      if(migration.version>17)continue;
      migration.up(sqlite);
      record.run(migration.version,migration.name,new Date().toISOString());
    }
  });
  run.immediate();
}

migrations.push({ version: 11, name: "project-console-work-ledger", up: migrateProjectConsole });
migrations.push({ version: 12, name: "bounded-agent-progress", up(sqlite) {
  addColumnIfMissing(sqlite, "local_agent_sessions", "progress", "text");
} });
migrations.push({ version: 13, name: "workspace-recovery-state", up: migrateWorkspaceRecoveryState });
migrations.push({ version: 14, name: "successful-execution-responses", up(sqlite) {
  sqlite.exec(`create table if not exists execution_responses (
    execution_id text primary key references console_executions(id),
    response text not null, sha256 text not null, bytes integer not null
  );`);
} });
migrations.push({ version: 15, name: "agent-history-handoff-lineage", up(sqlite) {
  addColumnIfMissing(sqlite, "local_agent_sessions", "recovery_type", "text");
  addColumnIfMissing(sqlite, "local_agent_sessions", "parent_provider_session_id", "text");
} });
migrations.push({ version: 16, name: "local-agent-turns", up: migrateLocalAgentTurns });
migrations.push({ version: 17, name: "managed-agent-turn-control", up(sqlite) {
  addColumnIfMissing(sqlite, "local_agent_sessions", "control_state", "text not null default 'terminal'");
  addColumnIfMissing(sqlite, "local_agent_sessions", "provider_turn_id", "text");
  addColumnIfMissing(sqlite, "local_agent_sessions", "control_revision", "integer not null default 0");
  sqlite.exec(`
    create table if not exists agent_control_requests (
      agent_id text not null references local_agent_sessions(id) on delete cascade,
      request_key text not null,
      request_hash text not null,
      action text not null,
      status text not null,
      receipt text,
      created_at text not null,
      updated_at text not null,
      primary key(agent_id, request_key)
    );
    create table if not exists agent_control_events (
      sequence integer primary key autoincrement,
      agent_id text not null references local_agent_sessions(id) on delete cascade,
      event_type text not null,
      control_state text not null,
      provider_thread_id text,
      provider_turn_id text,
      created_at text not null
    );
    create index if not exists agent_control_events_agent_sequence
      on agent_control_events(agent_id, sequence desc);
  `);
} });

// New execution ownership is opt-in until all command and Provider runners are
// Job-managed. Existing claims have NULL execution_id and remain legacy locks.
migrations.push({ version: 18, name: "proof-gated-execution-state", up(sqlite) {
  addColumnIfMissing(sqlite, "execution_claims", "execution_id", "text");
  // Preserve SQLite AUTOINCREMENT sequence and the old waiter order. SQLite
  // cannot DROP a NOT NULL constraint directly.
  const waiterColumns = sqlite.pragma("table_info(execution_waiters)") as Array<{ name: string; notnull: number }>;
  if (waiterColumns.find((column) => column.name === "expires_at_ms")?.notnull) {
    sqlite.exec(`
      alter table execution_waiters rename to execution_waiters_v18_old;
      create table execution_waiters (
        sequence integer primary key autoincrement,
        id text not null unique, owner_id text not null, owner_pid integer not null,
        kind text not null, checkout_root text not null, agent_id text,
        thread_key text, access_mode text not null, resources text not null,
        expires_at_ms integer, execution_id text
      );
      insert into execution_waiters
        (sequence,id,owner_id,owner_pid,kind,checkout_root,agent_id,thread_key,access_mode,resources,expires_at_ms)
      select sequence,id,owner_id,owner_pid,kind,checkout_root,agent_id,thread_key,access_mode,resources,expires_at_ms
        from execution_waiters_v18_old;
      drop table execution_waiters_v18_old;
      create index execution_waiters_order on execution_waiters(sequence);
    `);
  } else {
    addColumnIfMissing(sqlite, "execution_waiters", "execution_id", "text");
  }
  sqlite.exec(`
    create table if not exists execution_owners (
      id text primary key,
      kind text not null check (kind in ('mcp','agentd')),
      pid integer not null check (pid > 0),
      process_created_at text not null,
      boot_id text not null,
      generation text not null,
      heartbeat_at_ms integer not null,
      status text not null default 'active' check (status in ('active','suspect','dead')),
      registered_at text not null
    );
    create index if not exists execution_owners_heartbeat on execution_owners(heartbeat_at_ms);

    create table if not exists managed_executions (
      id text primary key,
      kind text not null check (kind in ('agent','command','service')),
      workspace_id text not null,
      checkout_root text not null,
      work_run_id text,
      agent_execution_id text,
      command_operation_id text,
      owner_id text not null references execution_owners(id),
      owner_generation text not null,
      runner_pid integer,
      runner_created_at text,
      runner_boot_id text,
      job_identity text,
      armed_evidence text,
      armed_at text,
      generation integer not null default 1 check (generation > 0),
      access_mode text not null check (access_mode in ('read','write','watch','exclusive')),
      resources text not null,
      phase text not null check (phase in ('queued','starting','running','stopping','terminal')),
      outcome text not null default 'pending' check (outcome in ('pending','completed','failed','cancelled','interrupted','unknown')),
      resource_state text not null check (resource_state in ('unclaimed','held','cleanup_pending','released','quarantined')),
      stop_reason text,
      idempotency_scope text not null,
      request_key text,
      request_hash text not null,
      cancellation_requested_at text,
      exit_evidence text,
      recovery_reason text,
      state_version integer not null default 0,
      created_at text not null,
      updated_at text not null,
      unique (idempotency_scope, request_key)
    );
    create index if not exists managed_executions_owner on managed_executions(owner_id, phase);
    create index if not exists managed_executions_resources on managed_executions(resource_state, phase);
    create index if not exists managed_executions_checkout on managed_executions(checkout_root, phase);

    create table if not exists execution_audit (
      sequence integer primary key autoincrement,
      execution_id text not null references managed_executions(id),
      generation integer not null,
      action text not null,
      previous_state text,
      next_state text,
      evidence text,
      created_at text not null
    );
    create index if not exists execution_audit_execution on execution_audit(execution_id, sequence);
  `);
} });

// Queue tickets created by the opt-in Windows managed runner must retain the
// EXACT owner generation even if the daemon exits before promotion. Existing
// legacy tickets remain NULL and are never silently promoted by recovery.
migrations.push({ version: 19, name: "managed-queue-owner-generation", up(sqlite) {
  addColumnIfMissing(sqlite, "execution_waiters", "owner_generation", "text");
  sqlite.exec(`
    create index if not exists execution_waiters_managed_owner
      on execution_waiters(owner_id,owner_generation,expires_at_ms);
    create table if not exists managed_queue_recovery_audit (
      sequence integer primary key autoincrement,
      ticket_id text not null unique,
      owner_id text not null,
      owner_generation text not null,
      agent_id text not null,
      disposition text not null,
      evidence text not null,
      created_at text not null
    );
  `);
} });

// Opt-in persistent services have their OWN port, storage and ownership
// namespace. Their reservations are deliberately not execution_claims:
// an Agent Job completing can never release or consume a service slot.
migrations.push({ version: 20, name: "managed-service-reservations", up(sqlite) {
  sqlite.exec(`
    create table if not exists managed_service_reservations (
      service_id text primary key,
      service_key text not null,
      owner_id text not null references execution_owners(id),
      owner_generation text not null,
      execution_id text not null unique references managed_executions(id),
      checkout_root text not null,
      state_root text not null,
      bind_host text not null,
      port integer not null check(port between 1 and 65535),
      state text not null check(state in ('reserved','running','stopping','released','quarantined')),
      created_at text not null,
      updated_at text not null
    );
    create unique index if not exists managed_service_active_key
      on managed_service_reservations(service_key) where state!='released';
    create unique index if not exists managed_service_active_port
      on managed_service_reservations(port) where state!='released';
    create unique index if not exists managed_service_active_state_root
      on managed_service_reservations(state_root) where state!='released';
    create index if not exists managed_service_owner
      on managed_service_reservations(owner_id,owner_generation,state);
  `);
} });

// Service health is an append-only observation, never permission to kill,
// release, or steal a service's native Windows Job.
migrations.push({ version: 21, name: "managed-service-health-journal", up(sqlite) {
  sqlite.exec(`
    create table if not exists managed_service_health_journal (
      sequence integer primary key autoincrement,
      service_id text not null references managed_service_reservations(service_id),
      owner_id text not null,
      owner_generation text not null,
      outcome text not null check(outcome in ('healthy','unhealthy','probe_error')),
      note text not null,
      sampled_at text not null
    );
    create index if not exists managed_service_health_by_service
      on managed_service_health_journal(service_id, sequence);
  `);
} });

function migrateWorkspaceState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_sessions (
      id text primary key,
      root text not null,
      status text not null default 'active',
      mode text not null default 'checkout',
      source_root text,
      base_ref text,
      base_sha text,
      managed text not null default 'false',
      created_at text not null,
      last_used_at text not null
    );

    create index if not exists workspace_sessions_root_idx
      on workspace_sessions(root, last_used_at desc);

    create index if not exists workspace_sessions_status_idx
      on workspace_sessions(status, last_used_at desc);

    create table if not exists loaded_agent_files (
      workspace_session_id text not null,
      path text not null,
      content_hash text not null,
      content text not null,
      loaded_at text not null,
      last_seen_at text not null,
      primary key (workspace_session_id, path),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists loaded_agent_files_path_idx
      on loaded_agent_files(path);
  `);

  addColumnIfMissing(sqlite, "workspace_sessions", "mode", "text not null default 'checkout'");
  addColumnIfMissing(sqlite, "workspace_sessions", "source_root", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_ref", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_sha", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "managed", "text not null default 'false'");
}

function migrateOAuthState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists oauth_clients (
      client_id text primary key,
      client_json text not null,
      issued_at integer not null
    );

    create index if not exists oauth_clients_issued_at_idx
      on oauth_clients(issued_at desc);

    create table if not exists oauth_access_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_access_tokens_client_id_idx
      on oauth_access_tokens(client_id);

    create index if not exists oauth_access_tokens_expires_at_idx
      on oauth_access_tokens(expires_at);

    create table if not exists oauth_refresh_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_refresh_tokens_client_id_idx
      on oauth_refresh_tokens(client_id);

    create index if not exists oauth_refresh_tokens_expires_at_idx
      on oauth_refresh_tokens(expires_at);
  `);
}

function migrateLocalAgentSessions(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists local_agent_sessions (
      id text primary key,
      workspace_id text,
      workspace_root text not null,
      profile_name text not null,
      provider text not null,
      model text,
      effort text,
      provider_session_id text,
      status text not null,
      latest_response text,
      error text,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists local_agent_sessions_workspace_id_idx
      on local_agent_sessions(workspace_id, updated_at desc);

    create index if not exists local_agent_sessions_workspace_root_idx
      on local_agent_sessions(workspace_root, updated_at desc);

    create index if not exists local_agent_sessions_provider_session_id_idx
      on local_agent_sessions(provider_session_id);
  `);

  addColumnIfMissing(sqlite, "local_agent_sessions", "effort", "text");
}

function migrateWorkspaceConversationBindings(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_conversation_bindings (
      conversation_scope_id text not null,
      target_key text not null,
      workspace_session_id text not null,
      created_at text not null,
      last_used_at text not null,
      primary key (conversation_scope_id, target_key),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists workspace_conversation_bindings_workspace_idx
      on workspace_conversation_bindings(workspace_session_id);
  `);
}

function migrateLocalAgentStructuredErrors(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "local_agent_sessions", "error_code", "text");
  addColumnIfMissing(sqlite, "local_agent_sessions", "error_retryable", "text");
}

function migrateLocalAgentEffortRename(sqlite: Database.Database): void {
  const columns = sqlite.prepare("pragma table_info(local_agent_sessions)").all() as Array<{
    name: string;
  }>;
  const names = new Set(columns.map((column) => column.name));
  if (names.has("effort")) {
    if (names.has("thinking")) {
      sqlite.exec(`
        update local_agent_sessions
        set effort = thinking
        where effort is null and thinking is not null
      `);
    }
    return;
  }
  if (!names.has("thinking")) {
    addColumnIfMissing(sqlite, "local_agent_sessions", "effort", "text");
    return;
  }
  sqlite.exec("alter table local_agent_sessions rename column thinking to effort");
}

function migrateWorkspaceRecoveryState(sqlite: Database.Database): void {
  const workspaceStateExists = sqlite
    .prepare("select 1 from sqlite_master where type = 'table' and name = 'workspace_sessions'")
    .get();
  if (!workspaceStateExists) return;

  addColumnIfMissing(sqlite, "workspace_sessions", "recovery_kind", "text");
}

function migrateLocalAgentTurns(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists local_agent_turns (
      id integer primary key autoincrement,
      agent_id text not null,
      prompt text not null,
      status text not null,
      response text,
      error text,
      error_code text,
      error_retryable text,
      created_at text not null,
      completed_at text,
      foreign key (agent_id) references local_agent_sessions(id) on delete cascade
    );

    create index if not exists local_agent_turns_agent_id_idx
      on local_agent_turns(agent_id, id desc);

    create index if not exists local_agent_turns_status_idx
      on local_agent_turns(status);
  `);
}

function addColumnIfMissing(
  sqlite: Database.Database,
  table: "workspace_sessions" | "local_agent_sessions" | "execution_claims" | "execution_waiters",
  column: string,
  definition: string,
): void {
  const columns = sqlite.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((existingColumn) => existingColumn.name === column)) return;

  sqlite.exec(`alter table ${table} add column ${column} ${definition}`);
}
