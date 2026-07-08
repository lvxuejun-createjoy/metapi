import { describe, expect, it } from 'vitest';
import {
  buildInsertStatement,
  buildTablePlan,
  DEFAULT_RUNTIME_DATA_TABLES,
  parseMigrationOptions,
  resolveTables,
} from './migrate-sqlite-runtime-data.js';

describe('migrate sqlite runtime data script', () => {
  it('builds postgres inserts that skip existing primary keys', () => {
    const sql = buildInsertStatement({
      dialect: 'postgres',
      table: 'proxy_logs',
      columns: ['id', 'status', 'created_at'],
      primaryKeyColumns: ['id'],
      rowCount: 2,
      mode: 'skip-existing',
    });

    expect(sql).toBe(
      'INSERT INTO "proxy_logs" ("id", "status", "created_at") VALUES ($1, $2, $3), ($4, $5, $6) ON CONFLICT ("id") DO NOTHING',
    );
  });

  it('builds mysql inserts that skip existing primary keys', () => {
    const sql = buildInsertStatement({
      dialect: 'mysql',
      table: 'proxy_logs',
      columns: ['id', 'status'],
      primaryKeyColumns: ['id'],
      rowCount: 2,
      mode: 'skip-existing',
    });

    expect(sql).toBe(
      'INSERT IGNORE INTO `proxy_logs` (`id`, `status`) VALUES (?, ?), (?, ?)',
    );
  });

  it('resolves default runtime data tables without checkin logs unless requested', () => {
    expect(resolveTables(undefined)).toEqual([...DEFAULT_RUNTIME_DATA_TABLES]);
    expect(resolveTables(undefined, true)).toContain('checkin_logs');
  });

  it('rejects unknown table names', () => {
    expect(() => resolveTables('proxy_logs,missing_table')).toThrow('Unknown table "missing_table"');
  });

  it('builds table plans from the generated schema contract', () => {
    const plan = buildTablePlan('proxy_logs');

    expect(plan.columns).toContain('billing_details');
    expect(plan.primaryKeyColumns).toEqual(['id']);
    expect(plan.jsonColumns.has('billing_details')).toBe(true);
  });

  it('parses required command line options and defaults safely', () => {
    const options = parseMigrationOptions([
      '--target',
      'postgres',
      '--url',
      'postgres://metapi:secret@127.0.0.1:5432/metapi',
      '--sqlite',
      '/tmp/hub.db',
      '--dry-run',
    ], {});

    expect(options.target).toBe('postgres');
    expect(options.targetUrl).toBe('postgres://metapi:secret@127.0.0.1:5432/metapi');
    expect(options.sqlitePath).toBe('/tmp/hub.db');
    expect(options.dryRun).toBe(true);
    expect(options.mode).toBe('skip-existing');
  });
});
