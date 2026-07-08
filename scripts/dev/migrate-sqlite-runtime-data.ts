import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import pg from 'pg';
import schemaContract from '../../src/server/db/generated/schemaContract.json' with { type: 'json' };

type TargetDialect = 'postgres' | 'mysql';
type MigrationMode = 'skip-existing' | 'replace';

type SchemaContract = {
  tables: Record<string, {
    columns: Record<string, { primaryKey?: boolean; logicalType?: string }>;
  }>;
};

type TablePlan = {
  table: string;
  columns: string[];
  primaryKeyColumns: string[];
  jsonColumns: Set<string>;
  numericIdColumn: string | null;
};

type MigrationOptions = {
  sqlitePath: string;
  target: TargetDialect;
  targetUrl: string;
  ssl: boolean;
  tables: string[];
  batchSize: number;
  mode: MigrationMode;
  ensureSchema: boolean;
  dryRun: boolean;
  yes: boolean;
};

type TargetClient = {
  dialect: TargetDialect;
  query(sqlText: string, params?: unknown[]): Promise<unknown>;
  close(): Promise<void>;
};

export const DEFAULT_RUNTIME_DATA_TABLES = [
  'proxy_logs',
  'admin_snapshots',
  'site_hour_usage',
  'site_day_usage',
  'model_day_usage',
  'analytics_projection_checkpoints',
] as const;

export const OPTIONAL_RUNTIME_DATA_TABLES = [
  'checkin_logs',
] as const;

const DEFAULT_BATCH_SIZE = 1_000;

function quoteIdentifier(dialect: TargetDialect, value: string): string {
  const escaped = value.replace(/"/g, '""').replace(/`/g, '``');
  return dialect === 'postgres' ? `"${escaped}"` : `\`${escaped}\``;
}

function buildPlaceholderList(dialect: TargetDialect, startIndex: number, count: number): string {
  return Array.from({ length: count }, (_, index) => (
    dialect === 'postgres' ? `$${startIndex + index}` : '?'
  )).join(', ');
}

export function buildInsertStatement(input: {
  dialect: TargetDialect;
  table: string;
  columns: string[];
  primaryKeyColumns: string[];
  rowCount: number;
  mode: MigrationMode;
}): string {
  const quotedTable = quoteIdentifier(input.dialect, input.table);
  const quotedColumns = input.columns.map((column) => quoteIdentifier(input.dialect, column)).join(', ');
  const rowPlaceholders = Array.from({ length: input.rowCount }, (_, rowIndex) => (
    `(${buildPlaceholderList(input.dialect, rowIndex * input.columns.length + 1, input.columns.length)})`
  )).join(', ');

  if (input.dialect === 'mysql') {
    const verb = input.mode === 'skip-existing' ? 'INSERT IGNORE' : 'INSERT';
    return `${verb} INTO ${quotedTable} (${quotedColumns}) VALUES ${rowPlaceholders}`;
  }

  const conflictClause = input.mode === 'skip-existing' && input.primaryKeyColumns.length > 0
    ? ` ON CONFLICT (${input.primaryKeyColumns.map((column) => quoteIdentifier(input.dialect, column)).join(', ')}) DO NOTHING`
    : '';
  return `INSERT INTO ${quotedTable} (${quotedColumns}) VALUES ${rowPlaceholders}${conflictClause}`;
}

function parseCsv(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function resolveTables(raw: string | undefined, includeCheckinLogs = false): string[] {
  const available = new Set(Object.keys((schemaContract as SchemaContract).tables));
  const defaults = [
    ...DEFAULT_RUNTIME_DATA_TABLES,
    ...(includeCheckinLogs ? OPTIONAL_RUNTIME_DATA_TABLES : []),
  ];
  const tables = !raw || raw === 'default'
    ? defaults
    : raw === 'all-runtime'
      ? [...defaults]
      : parseCsv(raw);

  for (const table of tables) {
    if (!available.has(table)) {
      throw new Error(`Unknown table "${table}". Use --tables with schema contract table names.`);
    }
  }
  return [...new Set(tables)];
}

export function buildTablePlan(table: string): TablePlan {
  const contract = schemaContract as SchemaContract;
  const tableContract = contract.tables[table];
  if (!tableContract) {
    throw new Error(`Unknown table "${table}"`);
  }
  const columns = Object.keys(tableContract.columns);
  const primaryKeyColumns = columns.filter((column) => tableContract.columns[column]?.primaryKey);
  const jsonColumns = new Set(
    columns.filter((column) => tableContract.columns[column]?.logicalType === 'json'),
  );
  const numericIdColumn = primaryKeyColumns.length === 1 && primaryKeyColumns[0] === 'id' ? 'id' : null;
  return { table, columns, primaryKeyColumns, jsonColumns, numericIdColumn };
}

function normalizeRowValue(plan: TablePlan, column: string, value: unknown): unknown {
  if (value == null) return null;
  if (!plan.jsonColumns.has(column)) return value;
  if (typeof value !== 'string') return JSON.stringify(value);
  const text = value.trim();
  return text ? text : null;
}

function flattenRows(plan: TablePlan, rows: Array<Record<string, unknown>>): unknown[] {
  const params: unknown[] = [];
  for (const row of rows) {
    for (const column of plan.columns) {
      params.push(normalizeRowValue(plan, column, row[column]));
    }
  }
  return params;
}

function readRows(sqlite: Database.Database, plan: TablePlan, afterId: number | null, limit: number): Array<Record<string, unknown>> {
  const selectColumns = plan.columns.map((column) => `"${column.replace(/"/g, '""')}"`).join(', ');
  if (plan.numericIdColumn) {
    return sqlite.prepare(
      `SELECT ${selectColumns} FROM "${plan.table}" WHERE "id" > ? ORDER BY "id" ASC LIMIT ?`,
    ).all(afterId ?? 0, limit) as Array<Record<string, unknown>>;
  }
  return sqlite.prepare(
    `SELECT ${selectColumns} FROM "${plan.table}" ORDER BY rowid ASC LIMIT ? OFFSET ?`,
  ).all(limit, afterId ?? 0) as Array<Record<string, unknown>>;
}

function countSourceRows(sqlite: Database.Database, table: string): number {
  const row = sqlite.prepare(`SELECT count(*) AS count FROM "${table}"`).get() as { count?: number };
  return Number(row?.count || 0);
}

async function countTargetRows(target: TargetClient, table: string): Promise<number> {
  const quotedTable = quoteIdentifier(target.dialect, table);
  const result = await target.query(`SELECT count(*) AS count FROM ${quotedTable}`);
  const rows = (result as any)?.rows || (Array.isArray(result) ? result[0] : []);
  const first = Array.isArray(rows) ? rows[0] : null;
  return Number(first?.count || 0);
}

async function deleteTargetRows(target: TargetClient, tables: string[]): Promise<void> {
  for (const table of [...tables].reverse()) {
    await target.query(`DELETE FROM ${quoteIdentifier(target.dialect, table)}`);
  }
}

async function resetTargetIdentity(target: TargetClient, plan: TablePlan): Promise<void> {
  if (!plan.numericIdColumn) return;
  const table = quoteIdentifier(target.dialect, plan.table);
  if (target.dialect === 'postgres') {
    await target.query(
      `SELECT setval(pg_get_serial_sequence('${plan.table}', 'id'), COALESCE((SELECT MAX("id") FROM ${table}), 0) + 1, false)`,
    );
    return;
  }
  await target.query(`ALTER TABLE ${table} AUTO_INCREMENT = 1`);
}

async function migrateTable(input: {
  sqlite: Database.Database;
  target: TargetClient;
  plan: TablePlan;
  batchSize: number;
  mode: MigrationMode;
  dryRun: boolean;
}): Promise<{ table: string; sourceRows: number; targetRowsBefore: number; targetRowsAfter: number; insertedOrSkipped: number }> {
  const sourceRows = countSourceRows(input.sqlite, input.plan.table);
  const targetRowsBefore = await countTargetRows(input.target, input.plan.table);
  let copied = 0;
  let cursor: number | null = null;

  for (;;) {
    const rows = readRows(input.sqlite, input.plan, cursor, input.batchSize);
    if (rows.length === 0) break;
    if (!input.dryRun) {
      const statement = buildInsertStatement({
        dialect: input.target.dialect,
        table: input.plan.table,
        columns: input.plan.columns,
        primaryKeyColumns: input.plan.primaryKeyColumns,
        rowCount: rows.length,
        mode: input.mode,
      });
      await input.target.query(statement, flattenRows(input.plan, rows));
    }
    copied += rows.length;
    if (input.plan.numericIdColumn) {
      cursor = Number(rows[rows.length - 1]?.id || 0);
    } else {
      cursor = (cursor ?? 0) + rows.length;
    }
  }

  if (!input.dryRun) {
    await resetTargetIdentity(input.target, input.plan);
  }

  const targetRowsAfter = input.dryRun ? targetRowsBefore : await countTargetRows(input.target, input.plan.table);
  return {
    table: input.plan.table,
    sourceRows,
    targetRowsBefore,
    targetRowsAfter,
    insertedOrSkipped: copied,
  };
}

function splitSqlStatements(sqlText: string): string[] {
  return sqlText
    .split(/;\s*(?:\r?\n|$)/g)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function ensureTargetSchema(target: TargetClient): Promise<void> {
  const sqlPath = resolve(
    'src/server/db/generated',
    target.dialect === 'postgres' ? 'postgres.bootstrap.sql' : 'mysql.bootstrap.sql',
  );
  const sqlText = readFileSync(sqlPath, 'utf8');
  for (const statement of splitSqlStatements(sqlText)) {
    try {
      await target.query(statement);
    } catch (error) {
      if (isIgnorableSchemaAlreadyExistsError(error)) continue;
      throw error;
    }
  }
}

function isIgnorableSchemaAlreadyExistsError(error: unknown): boolean {
  const err = error as { code?: string | number; errno?: number; message?: string };
  const code = String(err?.code || err?.errno || '');
  const message = String(err?.message || '').toLowerCase();
  return code === '42P07'
    || code === '42710'
    || code === '1061'
    || message.includes('already exists')
    || message.includes('duplicate key name');
}

async function createTargetClient(options: MigrationOptions): Promise<TargetClient> {
  if (options.target === 'postgres') {
    const pool = new pg.Pool({
      connectionString: options.targetUrl,
      ...(options.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    });
    return {
      dialect: 'postgres',
      query: async (sqlText, params = []) => pool.query(sqlText, params),
      close: async () => pool.end(),
    };
  }

  const pool = mysql.createPool({
    uri: options.targetUrl,
    jsonStrings: true,
    ...(options.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  return {
    dialect: 'mysql',
    query: async (sqlText, params = []) => pool.query(sqlText, params),
    close: async () => pool.end(),
  };
}

function readArgValue(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  return undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

export function parseMigrationOptions(args: string[], env: NodeJS.ProcessEnv = process.env): MigrationOptions {
  const targetRaw = (readArgValue(args, '--target') || env.DB_TYPE || '').trim().toLowerCase();
  const target = targetRaw === 'mysql' ? 'mysql' : targetRaw === 'postgres' || targetRaw === 'postgresql' ? 'postgres' : null;
  if (!target) {
    throw new Error('Target dialect is required: --target postgres|mysql');
  }

  const targetUrl = readArgValue(args, '--url') || env.DB_URL || '';
  if (!targetUrl.trim()) {
    throw new Error('Target DB URL is required: --url <connection-string> or DB_URL');
  }

  const sqlitePath = readArgValue(args, '--sqlite') || resolve(env.DATA_DIR || './data', 'hub.db');
  const batchSize = Math.max(1, Math.trunc(Number(readArgValue(args, '--batch-size') || DEFAULT_BATCH_SIZE)));
  const modeRaw = (readArgValue(args, '--mode') || 'skip-existing').trim();
  const mode: MigrationMode = modeRaw === 'replace' ? 'replace' : 'skip-existing';
  const tables = resolveTables(readArgValue(args, '--tables'), hasFlag(args, '--include-checkin-logs'));

  return {
    sqlitePath,
    target,
    targetUrl,
    ssl: hasFlag(args, '--ssl') || String(env.DB_SSL || '').toLowerCase() === 'true',
    tables,
    batchSize,
    mode,
    ensureSchema: hasFlag(args, '--ensure-schema'),
    dryRun: hasFlag(args, '--dry-run'),
    yes: hasFlag(args, '--yes'),
  };
}

async function run(options: MigrationOptions): Promise<void> {
  if (!existsSync(options.sqlitePath)) {
    throw new Error(`SQLite database not found: ${options.sqlitePath}`);
  }
  if (!options.yes && !options.dryRun) {
    throw new Error('Refusing to migrate without --yes. Run with --dry-run first if you want a preview.');
  }

  const sqlite = new Database(options.sqlitePath, { readonly: true });
  const target = await createTargetClient(options);
  try {
    if (options.ensureSchema && !options.dryRun) {
      console.log(`[migrate] ensuring ${options.target} schema...`);
      await ensureTargetSchema(target);
    }

    const plans = options.tables.map(buildTablePlan);
    if (options.mode === 'replace' && !options.dryRun) {
      console.log(`[migrate] deleting target rows from ${options.tables.join(', ')}...`);
      await deleteTargetRows(target, options.tables);
    }

    for (const plan of plans) {
      const result = await migrateTable({
        sqlite,
        target,
        plan,
        batchSize: options.batchSize,
        mode: options.mode,
        dryRun: options.dryRun,
      });
      console.log(
        `[migrate] ${result.table}: source=${result.sourceRows}, targetBefore=${result.targetRowsBefore}, targetAfter=${result.targetRowsAfter}, processed=${result.insertedOrSkipped}`,
      );
    }
  } finally {
    sqlite.close();
    await target.close();
  }
}

function isDirectRun(): boolean {
  return process.argv[1] != null && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

function printUsage(): void {
  console.log(`Usage:
  npm run db:migrate-runtime-data -- --target postgres --url "postgres://user:pass@host:5432/metapi" --sqlite ./data/hub.db --ensure-schema --yes
  npm run db:migrate-runtime-data -- --target mysql --url "mysql://user:pass@host:3306/metapi" --sqlite ./data/hub.db --ensure-schema --yes

Options:
  --target postgres|mysql       Target database dialect. Falls back to DB_TYPE.
  --url <connection-string>     Target database URL. Falls back to DB_URL.
  --sqlite <path>               Source SQLite file. Defaults to DATA_DIR/hub.db or ./data/hub.db.
  --tables <csv>                Tables to migrate. Defaults to runtime logs/statistics tables.
  --include-checkin-logs        Also migrate checkin_logs.
  --batch-size <n>              Rows per insert batch. Defaults to ${DEFAULT_BATCH_SIZE}.
  --mode skip-existing|replace  skip-existing is non-destructive; replace deletes target rows first.
  --ensure-schema               Create target schema from generated bootstrap SQL before migration.
  --ssl                         Enable relaxed SSL for the target database.
  --dry-run                     Count and preview without inserting rows.
  --yes                         Required for non-dry-run migrations.
`);
}

if (isDirectRun()) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }
  run(parseMigrationOptions(process.argv.slice(2))).catch((error) => {
    console.error(`[migrate] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
