import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type ConfigModule = typeof import('../config.js');
type CleanupModule = typeof import('./logCleanupService.js');

describe('logCleanupService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let config: ConfigModule['config'];
  let cleanupConfiguredLogs: CleanupModule['cleanupConfiguredLogs'];
  let dataDir = '';
  let auditDir = '';
  let originalConfig: {
    logCleanupUsageLogsEnabled: boolean;
    logCleanupProgramLogsEnabled: boolean;
    logCleanupAuditFilesEnabled: boolean;
    logCleanupRetentionDays: number;
    proxySafetyAuditFileDir: string;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-log-cleanup-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const configModule = await import('../config.js');
    const cleanupModule = await import('./logCleanupService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    config = configModule.config;
    cleanupConfiguredLogs = cleanupModule.cleanupConfiguredLogs;
    originalConfig = {
      logCleanupUsageLogsEnabled: config.logCleanupUsageLogsEnabled,
      logCleanupProgramLogsEnabled: config.logCleanupProgramLogsEnabled,
      logCleanupAuditFilesEnabled: config.logCleanupAuditFilesEnabled,
      logCleanupRetentionDays: config.logCleanupRetentionDays,
      proxySafetyAuditFileDir: config.proxySafetyAuditFileDir,
    };
  });

  beforeEach(async () => {
    await db.delete(schema.events).run();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();

    config.logCleanupUsageLogsEnabled = false;
    config.logCleanupProgramLogsEnabled = false;
    config.logCleanupAuditFilesEnabled = false;
    config.logCleanupRetentionDays = 30;
    auditDir = mkdtempSync(join(dataDir, 'proxy-safety-audit-'));
    config.proxySafetyAuditFileDir = auditDir;
  });

  afterAll(() => {
    config.logCleanupUsageLogsEnabled = originalConfig.logCleanupUsageLogsEnabled;
    config.logCleanupProgramLogsEnabled = originalConfig.logCleanupProgramLogsEnabled;
    config.logCleanupAuditFilesEnabled = originalConfig.logCleanupAuditFilesEnabled;
    config.logCleanupRetentionDays = originalConfig.logCleanupRetentionDays;
    config.proxySafetyAuditFileDir = originalConfig.proxySafetyAuditFileDir;
    delete process.env.DATA_DIR;
  });

  async function seedAccount() {
    const site = await db.insert(schema.sites).values({
      name: 'cleanup-site',
      url: 'https://cleanup.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    return await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'cleanup-user',
      accessToken: 'cleanup-access-token',
      apiToken: 'cleanup-api-token',
      status: 'active',
    }).returning().get();
  }

  it('cleans usage logs and program logs older than retention days', async () => {
    const account = await seedAccount();

    await db.insert(schema.proxyLogs).values([
      {
        accountId: account.id,
        modelRequested: 'gpt-4.1-mini',
        status: 'success',
        createdAt: '2026-02-01 08:00:00',
      },
      {
        accountId: account.id,
        modelRequested: 'gpt-4.1-mini',
        status: 'success',
        createdAt: '2026-03-10 08:00:00',
      },
    ]).run();

    await db.insert(schema.events).values([
      {
        type: 'status',
        title: 'old event',
        message: 'cleanup me',
        createdAt: '2026-02-01 08:00:00',
      },
      {
        type: 'status',
        title: 'new event',
        message: 'keep me',
        createdAt: '2026-03-10 08:00:00',
      },
    ]).run();

    const result = await cleanupConfiguredLogs({
      usageLogsEnabled: true,
      programLogsEnabled: true,
      retentionDays: 7,
      nowMs: Date.parse('2026-03-12T00:00:00Z'),
    });

    expect(result.enabled).toBe(true);
    expect(result.usageLogsDeleted).toBe(1);
    expect(result.programLogsDeleted).toBe(1);
    expect(result.totalDeleted).toBe(2);

    const remainingProxyLogs = await db.select().from(schema.proxyLogs).all();
    const remainingEvents = await db.select().from(schema.events).all();
    expect(remainingProxyLogs).toHaveLength(1);
    expect(remainingProxyLogs[0]?.createdAt).toBe('2026-03-10 08:00:00');
    expect(remainingEvents).toHaveLength(1);
    expect(remainingEvents[0]?.title).toBe('new event');
  });

  it('skips cleanup when no target is enabled', async () => {
    const account = await seedAccount();

    await db.insert(schema.proxyLogs).values({
      accountId: account.id,
      modelRequested: 'gpt-4.1-mini',
      status: 'success',
      createdAt: '2026-01-01 08:00:00',
    }).run();
    await db.insert(schema.events).values({
      type: 'status',
      title: 'still here',
      createdAt: '2026-01-01 08:00:00',
    }).run();

    const result = await cleanupConfiguredLogs({
      usageLogsEnabled: false,
      programLogsEnabled: false,
      retentionDays: 7,
      nowMs: Date.parse('2026-03-12T00:00:00Z'),
    });

    expect(result.enabled).toBe(false);
    expect(result.totalDeleted).toBe(0);
    expect(await db.select().from(schema.proxyLogs).all()).toHaveLength(1);
    expect(await db.select().from(schema.events).all()).toHaveLength(1);
  });

  it('cleans old audit jsonl files, including daily-session subdirectories', async () => {
    const oldFile = join(auditDir, '2026-02-01.jsonl');
    const freshFile = join(auditDir, '2026-03-10.jsonl');
    const unrelatedFile = join(auditDir, 'notes.txt');
    const nestedDir = join(auditDir, '2026-02-01');
    const nestedFile = join(nestedDir, 'session-old.jsonl');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(oldFile, '{"old":true}\n', 'utf8');
    writeFileSync(freshFile, '{"fresh":true}\n', 'utf8');
    writeFileSync(unrelatedFile, 'keep me\n', 'utf8');
    writeFileSync(nestedFile, '{"nested":true}\n', 'utf8');

    const oldTime = new Date('2026-02-01T08:00:00Z');
    const freshTime = new Date('2026-03-10T08:00:00Z');
    utimesSync(oldFile, oldTime, oldTime);
    utimesSync(freshFile, freshTime, freshTime);
    utimesSync(unrelatedFile, oldTime, oldTime);
    utimesSync(nestedFile, oldTime, oldTime);

    const result = await cleanupConfiguredLogs({
      usageLogsEnabled: false,
      programLogsEnabled: false,
      auditFilesEnabled: true,
      retentionDays: 7,
      nowMs: Date.parse('2026-03-12T00:00:00Z'),
    });

    expect(result.enabled).toBe(true);
    expect(result.auditFilesDeleted).toBe(2);
    expect(result.totalDeleted).toBe(2);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(freshFile)).toBe(true);
    expect(existsSync(unrelatedFile)).toBe(true);
    expect(existsSync(nestedFile)).toBe(false);
  });
});
