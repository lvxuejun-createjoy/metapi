import { afterEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

type DbModule = typeof import('./index.js');

describe('sqlite default path resolution', () => {
  let dbModule: DbModule | null = null;

  afterEach(async () => {
    if (dbModule) {
      await dbModule.closeDbConnections();
      dbModule = null;
    }
    delete process.env.DATA_DIR;
    delete process.env.DB_URL;
    vi.resetModules();
  });

  it('uses an isolated temp sqlite path under vitest when no db env is configured', async () => {
    delete process.env.DATA_DIR;
    delete process.env.DB_URL;
    vi.resetModules();

    dbModule = await import('./index.js');
    const sqlitePath = dbModule.__dbProxyTestUtils.resolveSqlitePath();
    const sharedRepoPath = resolve('./data/hub.db');

    expect(sqlitePath).not.toBe(sharedRepoPath);
    expect(sqlitePath).toContain(tmpdir());
    expect(sqlitePath).toContain('metapi-vitest');
  });

  it('still honors explicit DATA_DIR when provided', async () => {
    process.env.DATA_DIR = resolve(tmpdir(), 'metapi-explicit-data-dir');
    delete process.env.DB_URL;
    vi.resetModules();

    dbModule = await import('./index.js');
    const sqlitePath = dbModule.__dbProxyTestUtils.resolveSqlitePath();

    expect(sqlitePath).toBe(resolve(process.env.DATA_DIR, 'hub.db'));
  });

  it('ignores the default repo DATA_DIR under vitest and still isolates sqlite', async () => {
    process.env.DATA_DIR = './data';
    delete process.env.DB_URL;
    vi.resetModules();

    dbModule = await import('./index.js');
    const sqlitePath = dbModule.__dbProxyTestUtils.resolveSqlitePath();
    const sharedRepoPath = resolve('./data/hub.db');

    expect(sqlitePath).not.toBe(sharedRepoPath);
    expect(sqlitePath).toContain(tmpdir());
    expect(sqlitePath).toContain('metapi-vitest');
  });

  it('ignores a cached default config data dir under vitest', async () => {
    delete process.env.DATA_DIR;
    delete process.env.DB_URL;
    vi.resetModules();

    const configModule = await import('../config.js');
    expect(configModule.config.dataDir).toBe('./data');

    process.env.DATA_DIR = './data';
    dbModule = await import('./index.js');
    const sqlitePath = dbModule.__dbProxyTestUtils.resolveSqlitePath();
    const sharedRepoPath = resolve('./data/hub.db');

    expect(sqlitePath).not.toBe(sharedRepoPath);
    expect(sqlitePath).toContain(tmpdir());
    expect(sqlitePath).toContain('metapi-vitest');
  });

  it('rejects the repository hub database under vitest even when explicitly requested', async () => {
    delete process.env.DATA_DIR;
    process.env.DB_URL = resolve('./data/hub.db');
    vi.resetModules();

    await expect(import('./index.js')).rejects.toThrow(/Refusing to use the repository data database during Vitest/);
  });
});
