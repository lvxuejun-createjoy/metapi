import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

const { startChannelRecoveryProbeSchedulerMock, stopChannelRecoveryProbeSchedulerMock } = vi.hoisted(() => ({
  startChannelRecoveryProbeSchedulerMock: vi.fn(),
  stopChannelRecoveryProbeSchedulerMock: vi.fn(),
}));

vi.mock('../../services/channelRecoveryProbeService.js', () => ({
  startChannelRecoveryProbeScheduler: startChannelRecoveryProbeSchedulerMock,
  stopChannelRecoveryProbeScheduler: stopChannelRecoveryProbeSchedulerMock,
}));

type ConfigModule = typeof import('../../config.js');
type DbModule = typeof import('../../db/index.js');

describe('settings channel recovery probe runtime setting', () => {
  let app: FastifyInstance;
  let config: ConfigModule['config'];
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-settings-channel-recovery-probe-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const configModule = await import('../../config.js');
    const settingsRoutesModule = await import('./settings.js');

    db = dbModule.db;
    schema = dbModule.schema;
    config = configModule.config;

    app = Fastify();
    await app.register(settingsRoutesModule.settingsRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.settings).run();
    config.channelRecoveryProbeEnabled = true;
    startChannelRecoveryProbeSchedulerMock.mockReset();
    stopChannelRecoveryProbeSchedulerMock.mockReset();
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it('persists disabling channel recovery probes and stops the scheduler', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { channelRecoveryProbeEnabled: false },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { channelRecoveryProbeEnabled?: boolean }).channelRecoveryProbeEnabled).toBe(false);
    expect(config.channelRecoveryProbeEnabled).toBe(false);
    expect(stopChannelRecoveryProbeSchedulerMock).toHaveBeenCalledTimes(1);
    expect(startChannelRecoveryProbeSchedulerMock).not.toHaveBeenCalled();

    const saved = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'channel_recovery_probe_enabled'))
      .get();
    expect(saved?.value).toBe(JSON.stringify(false));
  });

  it('persists enabling channel recovery probes and starts the scheduler', async () => {
    config.channelRecoveryProbeEnabled = false;

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { channelRecoveryProbeEnabled: true },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { channelRecoveryProbeEnabled?: boolean }).channelRecoveryProbeEnabled).toBe(true);
    expect(config.channelRecoveryProbeEnabled).toBe(true);
    expect(startChannelRecoveryProbeSchedulerMock).toHaveBeenCalledTimes(1);
    expect(stopChannelRecoveryProbeSchedulerMock).not.toHaveBeenCalled();
  });
});
