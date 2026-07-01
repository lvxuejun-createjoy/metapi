import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { threadId } from 'node:worker_threads';

export interface SqlitePathConfig {
  dbUrl?: string;
  dataDir?: string;
}

export function isVitestRuntime(): boolean {
  if ((process.env.VITEST || '').trim()) return true;
  if ((process.env.VITEST_POOL_ID || '').trim()) return true;
  if ((process.env.VITEST_WORKER_ID || '').trim()) return true;
  const runtimeArgs = [...process.argv, ...process.execArgv]
    .map((value) => String(value || '').toLowerCase());
  return runtimeArgs.some((value) => value.includes('vitest'));
}

export function isDefaultRepoDataDir(value: string | undefined): boolean {
  const trimmed = (value || '').trim();
  if (!trimmed) return false;
  return resolve(trimmed) === resolve('./data');
}

export function resolveRepoHubDbPath(): string {
  return resolve('./data/hub.db');
}

export function resolveVitestSqlitePath(): string | null {
  if (!isVitestRuntime()) {
    return null;
  }
  if ((process.env.DB_URL || '').trim()) {
    return null;
  }
  if ((process.env.DATA_DIR || '').trim() && !isDefaultRepoDataDir(process.env.DATA_DIR)) {
    return null;
  }

  const workerTag = process.env.VITEST_POOL_ID
    || process.env.VITEST_WORKER_ID
    || `${process.pid}-${threadId}`;
  return resolve(tmpdir(), `metapi-vitest-${workerTag}`, 'hub.db');
}

export function assertSafeSqlitePath(sqlitePath: string): void {
  if (!isVitestRuntime() || sqlitePath === ':memory:') {
    return;
  }

  if (resolve(sqlitePath) === resolveRepoHubDbPath()) {
    throw new Error(
      `Refusing to use the repository data database during Vitest: ${sqlitePath}. `
      + 'Set DATA_DIR to a temporary directory or DB_URL to an explicit test database.',
    );
  }
}

export function resolveSqlitePathFromConfig(appConfig: SqlitePathConfig): string {
  const raw = (process.env.DB_URL || appConfig.dbUrl || '').trim();
  if (!raw) {
    const isolatedVitestPath = resolveVitestSqlitePath();
    if (isolatedVitestPath) {
      return isolatedVitestPath;
    }
    const dataDir = (process.env.DATA_DIR || appConfig.dataDir || './data').trim() || './data';
    const sqlitePath = resolve(`${dataDir}/hub.db`);
    assertSafeSqlitePath(sqlitePath);
    return sqlitePath;
  }
  if (raw === ':memory:') return raw;
  if (raw.startsWith('file://')) {
    const parsed = new URL(raw);
    const sqlitePath = decodeURIComponent(parsed.pathname);
    assertSafeSqlitePath(sqlitePath);
    return sqlitePath;
  }
  if (raw.startsWith('sqlite://')) {
    const sqlitePath = resolve(raw.slice('sqlite://'.length).trim());
    assertSafeSqlitePath(sqlitePath);
    return sqlitePath;
  }
  const sqlitePath = resolve(raw);
  assertSafeSqlitePath(sqlitePath);
  return sqlitePath;
}
