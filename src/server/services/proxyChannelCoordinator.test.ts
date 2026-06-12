import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config.js';
import {
  proxyChannelCoordinator,
  resetProxyChannelCoordinatorState,
} from './proxyChannelCoordinator.js';

describe('proxyChannelCoordinator', () => {
  const originalStickyEnabled = config.proxyStickySessionEnabled;
  const originalStickyTtlMs = config.proxyStickySessionTtlMs;
  const originalStickyFailureThreshold = config.proxyStickyFailureThreshold;
  const originalConcurrencyLimit = config.proxySessionChannelConcurrencyLimit;
  const originalQueueWaitMs = config.proxySessionChannelQueueWaitMs;
  const originalLeaseTtlMs = config.proxySessionChannelLeaseTtlMs;
  const originalLeaseKeepaliveMs = config.proxySessionChannelLeaseKeepaliveMs;

  beforeEach(() => {
    vi.useFakeTimers();
    config.proxyStickySessionEnabled = true;
    config.proxyStickySessionTtlMs = 31_000;
    config.proxyStickyFailureThreshold = 5;
    config.proxySessionChannelConcurrencyLimit = 1;
    config.proxySessionChannelQueueWaitMs = 200;
    config.proxySessionChannelLeaseTtlMs = 100;
    config.proxySessionChannelLeaseKeepaliveMs = 30;
    resetProxyChannelCoordinatorState();
  });

  afterEach(() => {
    config.proxyStickySessionEnabled = originalStickyEnabled;
    config.proxyStickySessionTtlMs = originalStickyTtlMs;
    config.proxyStickyFailureThreshold = originalStickyFailureThreshold;
    config.proxySessionChannelConcurrencyLimit = originalConcurrencyLimit;
    config.proxySessionChannelQueueWaitMs = originalQueueWaitMs;
    config.proxySessionChannelLeaseTtlMs = originalLeaseTtlMs;
    config.proxySessionChannelLeaseKeepaliveMs = originalLeaseKeepaliveMs;
    resetProxyChannelCoordinatorState();
    vi.useRealTimers();
  });

  it('stores sticky bindings for session-scoped channels and expires them by ttl', async () => {
    const key = proxyChannelCoordinator.buildStickySessionKey({
      clientKind: 'codex',
      sessionId: 'turn-123',
      requestedModel: 'gpt-5.2',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: 9,
    });

    proxyChannelCoordinator.bindStickyChannel(key, 42, JSON.stringify({ credentialMode: 'session' }));
    expect(proxyChannelCoordinator.getStickyChannelId(key)).toBe(42);

    await vi.advanceTimersByTimeAsync(31_100);
    expect(proxyChannelCoordinator.getStickyChannelId(key)).toBeNull();
  });

  it('reuses the same sticky key for the same session even when model and downstream path differ', () => {
    const firstKey = proxyChannelCoordinator.buildStickySessionKey({
      clientKind: 'claude_code',
      sessionId: 'session-abc-123',
      requestedModel: 'claude-sonnet-4-6',
      downstreamPath: '/v1/messages',
      downstreamApiKeyId: 9,
    });
    const secondKey = proxyChannelCoordinator.buildStickySessionKey({
      clientKind: 'claude_code',
      sessionId: 'session-abc-123',
      requestedModel: 'claude-opus-4-6',
      downstreamPath: '/v1/messages/count_tokens',
      downstreamApiKeyId: 9,
    });

    expect(firstKey).toBe('key:9|claude_code|session-abc-123');
    expect(secondKey).toBe(firstKey);
  });

  it('stores sticky bindings for apikey-only channels', () => {
    const key = proxyChannelCoordinator.buildStickySessionKey({
      clientKind: 'codex',
      sessionId: 'turn-456',
      requestedModel: 'gpt-5.2',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: 9,
    });

    proxyChannelCoordinator.bindStickyChannel(key, 42, JSON.stringify({ credentialMode: 'apikey' }));
    expect(proxyChannelCoordinator.getStickyChannelId(key)).toBe(42);
  });

  it('keeps sticky bindings until sticky failure threshold is reached', () => {
    const key = proxyChannelCoordinator.buildStickySessionKey({
      clientKind: 'claude_code',
      sessionId: 'session-soft-failure',
      requestedModel: 'claude-sonnet-4-6',
      downstreamPath: '/v1/messages',
      downstreamApiKeyId: 9,
    });
    proxyChannelCoordinator.bindStickyChannel(key, 42, JSON.stringify({ credentialMode: 'apikey' }));

    for (let attempt = 1; attempt < 5; attempt += 1) {
      const result = proxyChannelCoordinator.recordStickyFailure(key, 42);
      expect(result.count).toBe(attempt);
      expect(result.threshold).toBe(5);
      expect(result.thresholdReached).toBe(false);
      expect(proxyChannelCoordinator.getStickyChannelId(key)).toBe(42);
    }

    const finalResult = proxyChannelCoordinator.recordStickyFailure(key, 42);
    expect(finalResult.count).toBe(5);
    expect(finalResult.thresholdReached).toBe(true);
  });

  it('clears sticky failure counts when binding succeeds again', () => {
    const key = proxyChannelCoordinator.buildStickySessionKey({
      clientKind: 'claude_code',
      sessionId: 'session-soft-failure-reset',
      requestedModel: 'claude-sonnet-4-6',
      downstreamPath: '/v1/messages',
      downstreamApiKeyId: 9,
    });
    proxyChannelCoordinator.bindStickyChannel(key, 42, JSON.stringify({ credentialMode: 'apikey' }));
    expect(proxyChannelCoordinator.recordStickyFailure(key, 42).count).toBe(1);

    proxyChannelCoordinator.bindStickyChannel(key, 42, JSON.stringify({ credentialMode: 'apikey' }));

    const afterSuccess = proxyChannelCoordinator.recordStickyFailure(key, 42);
    expect(afterSuccess.count).toBe(1);
    expect(proxyChannelCoordinator.getStickyChannelId(key)).toBe(42);
  });

  it('treats structured oauth providers as session-scoped even when extraConfig omits oauth.provider', () => {
    const key = proxyChannelCoordinator.buildStickySessionKey({
      clientKind: 'codex',
      sessionId: 'turn-oauth-structured',
      requestedModel: 'gpt-5.2',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: 9,
    });

    proxyChannelCoordinator.bindStickyChannel(key, 42, {
      oauthProvider: 'codex',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    });
    expect(proxyChannelCoordinator.getStickyChannelId(key)).toBe(42);
  });

  it('queues requests behind the active lease and grants the next waiter after release', async () => {
    const first = await proxyChannelCoordinator.acquireChannelLease({
      channelId: 11,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    });
    expect(first.status).toBe('acquired');
    if (first.status !== 'acquired') return;

    let secondSettled = false;
    const secondPromise = proxyChannelCoordinator.acquireChannelLease({
      channelId: 11,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).then((result) => {
      secondSettled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(50);
    expect(secondSettled).toBe(false);

    first.lease.release();
    await vi.advanceTimersByTimeAsync(0);

    const second = await secondPromise;
    expect(second.status).toBe('acquired');
    if (second.status === 'acquired') {
      second.lease.release();
    }
  });

  it('times out queued requests when no slot becomes available', async () => {
    const first = await proxyChannelCoordinator.acquireChannelLease({
      channelId: 11,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    });
    expect(first.status).toBe('acquired');
    if (first.status !== 'acquired') return;

    const secondPromise = proxyChannelCoordinator.acquireChannelLease({
      channelId: 11,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    });

    await vi.advanceTimersByTimeAsync(250);
    await expect(secondPromise).resolves.toEqual({
      status: 'timeout',
      waitMs: 200,
    });

    first.lease.release();
  });

  it('keeps active leases alive until they are explicitly released', async () => {
    const first = await proxyChannelCoordinator.acquireChannelLease({
      channelId: 11,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    });
    expect(first.status).toBe('acquired');
    if (first.status !== 'acquired') return;

    let secondSettled = false;
    const secondPromise = proxyChannelCoordinator.acquireChannelLease({
      channelId: 11,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).then((result) => {
      secondSettled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(180);
    expect(first.lease.isActive()).toBe(true);
    expect(secondSettled).toBe(false);

    first.lease.release();
    await vi.advanceTimersByTimeAsync(0);

    const second = await secondPromise;
    expect(second.status).toBe('acquired');
    if (second.status === 'acquired') {
      second.lease.release();
    }
  });

  it('exposes the set of currently active leased channels', async () => {
    const lease = await proxyChannelCoordinator.acquireChannelLease({
      channelId: 23,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    });
    expect(lease.status).toBe('acquired');
    if (lease.status !== 'acquired') return;

    expect(proxyChannelCoordinator.getActiveChannelIds()).toEqual([23]);

    lease.lease.release();
    expect(proxyChannelCoordinator.getActiveChannelIds()).toEqual([]);
  });

  it('reports active and waiting load for a guarded session channel', async () => {
    const first = await proxyChannelCoordinator.acquireChannelLease({
      channelId: 31,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    });
    expect(first.status).toBe('acquired');
    if (first.status !== 'acquired') return;

    const secondPromise = proxyChannelCoordinator.acquireChannelLease({
      channelId: 31,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(proxyChannelCoordinator.getChannelLoadSnapshot({
      channelId: 31,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    })).toEqual({
      channelId: 31,
      sessionScoped: true,
      concurrencyLimit: 1,
      activeLeaseCount: 1,
      waitingCount: 1,
      loadRatio: 2,
      saturated: true,
    });

    first.lease.release();
    await vi.advanceTimersByTimeAsync(0);

    const second = await secondPromise;
    expect(second.status).toBe('acquired');
    if (second.status === 'acquired') {
      second.lease.release();
    }
  });

  it('treats structured oauth providers as session-scoped in load snapshots', () => {
    expect(proxyChannelCoordinator.getChannelLoadSnapshot({
      channelId: 41,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
      accountOauthProvider: 'codex',
    })).toEqual({
      channelId: 41,
      sessionScoped: true,
      concurrencyLimit: 1,
      activeLeaseCount: 0,
      waitingCount: 0,
      loadRatio: 0,
      saturated: false,
    });
  });
});
