import { lt } from 'drizzle-orm';
import { readdir, stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { formatUtcSqlDateTime } from './localTimeService.js';
import { normalizeLogCleanupRetentionDays } from '../shared/logCleanupRetentionDays.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export type LogCleanupOptions = {
  usageLogsEnabled?: boolean;
  programLogsEnabled?: boolean;
  auditFilesEnabled?: boolean;
  retentionDays?: number;
  nowMs?: number;
};

export type LogCleanupResult = {
  enabled: boolean;
  usageLogsEnabled: boolean;
  programLogsEnabled: boolean;
  auditFilesEnabled: boolean;
  retentionDays: number;
  cutoffUtc: string | null;
  usageLogsDeleted: number;
  programLogsDeleted: number;
  auditFilesDeleted: number;
  totalDeleted: number;
};

export function getLogCleanupCutoffUtc(retentionDays: number, nowMs = Date.now()): string | null {
  const normalizedDays = normalizeLogCleanupRetentionDays(retentionDays);
  return formatUtcSqlDateTime(new Date(nowMs - normalizedDays * DAY_MS));
}

export async function cleanupUsageLogs(retentionDays: number, nowMs = Date.now()): Promise<{
  retentionDays: number;
  cutoffUtc: string | null;
  deleted: number;
}> {
  const normalizedDays = normalizeLogCleanupRetentionDays(retentionDays);
  const cutoffUtc = getLogCleanupCutoffUtc(normalizedDays, nowMs);
  if (!cutoffUtc) {
    return {
      retentionDays: normalizedDays,
      cutoffUtc: null,
      deleted: 0,
    };
  }

  const deleted = (
    await db.delete(schema.proxyLogs)
      .where(lt(schema.proxyLogs.createdAt, cutoffUtc))
      .run()
  ).changes;

  return {
    retentionDays: normalizedDays,
    cutoffUtc,
    deleted,
  };
}

export async function cleanupProgramLogs(retentionDays: number, nowMs = Date.now()): Promise<{
  retentionDays: number;
  cutoffUtc: string | null;
  deleted: number;
}> {
  const normalizedDays = normalizeLogCleanupRetentionDays(retentionDays);
  const cutoffUtc = getLogCleanupCutoffUtc(normalizedDays, nowMs);
  if (!cutoffUtc) {
    return {
      retentionDays: normalizedDays,
      cutoffUtc: null,
      deleted: 0,
    };
  }

  const deleted = (
    await db.delete(schema.events)
      .where(lt(schema.events.createdAt, cutoffUtc))
      .run()
  ).changes;

  return {
    retentionDays: normalizedDays,
    cutoffUtc,
    deleted,
  };
}

export async function cleanupAuditFiles(retentionDays: number, nowMs = Date.now()): Promise<{
  retentionDays: number;
  cutoffUtc: string | null;
  deleted: number;
}> {
  const normalizedDays = normalizeLogCleanupRetentionDays(retentionDays);
  const cutoffUtc = getLogCleanupCutoffUtc(normalizedDays, nowMs);
  if (!cutoffUtc) {
    return {
      retentionDays: normalizedDays,
      cutoffUtc: null,
      deleted: 0,
    };
  }

  const cutoffMs = Date.parse(`${cutoffUtc.replace(' ', 'T')}Z`);
  if (!Number.isFinite(cutoffMs)) {
    return {
      retentionDays: normalizedDays,
      cutoffUtc,
      deleted: 0,
    };
  }

  const auditDir = resolve(config.proxySafetyAuditFileDir || './logs/proxy-safety-audit');
  let entries;
  try {
    entries = await readdir(auditDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return {
        retentionDays: normalizedDays,
        cutoffUtc,
        deleted: 0,
      };
    }
    throw error;
  }

  async function cleanupDirectory(directory: string, directoryEntries = entries): Promise<number> {
    let deleted = 0;
    for (const entry of directoryEntries) {
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        const nestedEntries = await readdir(entryPath, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
          if (error?.code === 'ENOENT') return [];
          throw error;
        });
        deleted += await cleanupDirectory(entryPath, nestedEntries);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const fileStat = await stat(entryPath).catch((error: NodeJS.ErrnoException) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (!fileStat || fileStat.mtimeMs >= cutoffMs) continue;
      const removed = await unlink(entryPath)
        .then(() => true)
        .catch((error: NodeJS.ErrnoException) => {
          if (error?.code === 'ENOENT') return false;
          throw error;
        });
      if (removed) deleted += 1;
    }
    return deleted;
  }

  const deleted = await cleanupDirectory(auditDir);

  return {
    retentionDays: normalizedDays,
    cutoffUtc,
    deleted,
  };
}

export async function cleanupConfiguredLogs(options: LogCleanupOptions = {}): Promise<LogCleanupResult> {
  const usageLogsEnabled = options.usageLogsEnabled ?? config.logCleanupUsageLogsEnabled;
  const programLogsEnabled = options.programLogsEnabled ?? config.logCleanupProgramLogsEnabled;
  const auditFilesEnabled = options.auditFilesEnabled ?? config.logCleanupAuditFilesEnabled;
  const retentionDays = normalizeLogCleanupRetentionDays(
    options.retentionDays ?? config.logCleanupRetentionDays,
    config.logCleanupRetentionDays,
  );
  const nowMs = options.nowMs ?? Date.now();
  const enabled = usageLogsEnabled || programLogsEnabled || auditFilesEnabled;
  const cutoffUtc = enabled ? getLogCleanupCutoffUtc(retentionDays, nowMs) : null;

  if (!enabled || !cutoffUtc) {
    return {
      enabled: false,
      usageLogsEnabled,
      programLogsEnabled,
      auditFilesEnabled,
      retentionDays,
      cutoffUtc,
      usageLogsDeleted: 0,
      programLogsDeleted: 0,
      auditFilesDeleted: 0,
      totalDeleted: 0,
    };
  }

  const usageResult = usageLogsEnabled
    ? await cleanupUsageLogs(retentionDays, nowMs)
    : { deleted: 0 };
  const programResult = programLogsEnabled
    ? await cleanupProgramLogs(retentionDays, nowMs)
    : { deleted: 0 };
  const auditResult = auditFilesEnabled
    ? await cleanupAuditFiles(retentionDays, nowMs)
    : { deleted: 0 };

  return {
    enabled: true,
    usageLogsEnabled,
    programLogsEnabled,
    auditFilesEnabled,
    retentionDays,
    cutoffUtc,
    usageLogsDeleted: usageResult.deleted,
    programLogsDeleted: programResult.deleted,
    auditFilesDeleted: auditResult.deleted,
    totalDeleted: usageResult.deleted + programResult.deleted + auditResult.deleted,
  };
}
