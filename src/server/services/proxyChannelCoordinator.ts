import { config } from '../config.js';
import {
  getCredentialModeFromExtraConfig,
  hasOauthProvider,
} from './accountExtraConfig.js';

type StickyEntry = {
  channelId: number;
  expiresAtMs: number;
};

type StickyFailureEntry = {
  count: number;
  updatedAtMs: number;
};

type ActiveLeaseState = {
  release: () => void;
};

type ChannelWaiter = {
  cancelled: boolean;
  resolve: (result: AcquireProxyChannelLeaseResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

type ChannelRuntimeState = {
  activeLeaseIds: Set<number>;
  queue: ChannelWaiter[];
};

export type ProxyChannelLoadSnapshot = {
  channelId: number;
  sessionScoped: boolean;
  concurrencyLimit: number;
  activeLeaseCount: number;
  waitingCount: number;
  loadRatio: number;
  saturated: boolean;
};

export type ProxyChannelLease = {
  channelId: number;
  isActive(): boolean;
  release(): void;
  touch(): void;
};

export type AcquireProxyChannelLeaseResult =
  | { status: 'acquired'; lease: ProxyChannelLease }
  | { status: 'timeout'; waitMs: number };

const stickySessionBindings = new Map<string, StickyEntry>();
const stickyFailureCounts = new Map<string, StickyFailureEntry>();
const channelRuntimeStates = new Map<number, ChannelRuntimeState>();
let nextLeaseId = 1;
type SessionScopedChannelInput =
  | string
  | null
  | undefined
  | {
    extraConfig?: string | null;
    oauthProvider?: string | null;
  };

function shouldUnrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>) {
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}

function cleanupExpiredStickyBindings(nowMs = Date.now()): void {
  for (const [key, entry] of stickySessionBindings.entries()) {
    if (entry.expiresAtMs <= nowMs) {
      stickySessionBindings.delete(key);
      for (const failureKey of stickyFailureCounts.keys()) {
        if (failureKey.startsWith(`${key}|`)) {
          stickyFailureCounts.delete(failureKey);
        }
      }
    }
  }
}

function getSessionScopedExtraConfig(input?: SessionScopedChannelInput): string | null | undefined {
  if (typeof input === 'string' || input == null) return input;
  return input.extraConfig;
}

function isSessionScopedChannel(input?: SessionScopedChannelInput): boolean {
  return getCredentialModeFromExtraConfig(getSessionScopedExtraConfig(input)) === 'session'
    || hasOauthProvider(input);
}

function canBindStickyChannel(_input?: SessionScopedChannelInput): boolean {
  return true;
}

function shouldLogStickyDiagnostics(): boolean {
  return config.proxyDebugTraceEnabled === true;
}

function summarizeStickySessionKey(stickySessionKey?: string | null): string {
  const normalized = String(stickySessionKey || '').trim();
  if (!normalized) return '';
  if (normalized.length <= 80) return normalized;
  return `${normalized.slice(0, 32)}...${normalized.slice(-16)}`;
}

function logStickyDiagnostics(event: string, details: Record<string, unknown>): void {
  if (!shouldLogStickyDiagnostics()) return;
  console.info(`[proxy/sticky] ${event}`, details);
}

function getStickySessionTtlMs(): number {
  return Math.max(30_000, Math.trunc(config.proxyStickySessionTtlMs || 0));
}

function getStickyFailureThreshold(): number {
  return Math.max(1, Math.trunc(config.proxyStickyFailureThreshold || 5));
}

function buildStickyFailureKey(stickySessionKey?: string | null, channelId?: number | null): string | null {
  const normalizedKey = String(stickySessionKey || '').trim();
  const normalizedChannelId = Math.trunc(channelId || 0);
  if (!normalizedKey || !Number.isFinite(normalizedChannelId) || normalizedChannelId <= 0) return null;
  return `${normalizedKey}|channel:${normalizedChannelId}`;
}

function getChannelLeaseTtlMs(): number {
  return Math.max(5_000, Math.trunc(config.proxySessionChannelLeaseTtlMs || 0));
}

function getChannelLeaseKeepaliveMs(): number {
  return Math.max(1_000, Math.trunc(config.proxySessionChannelLeaseKeepaliveMs || 0));
}

function getChannelQueueWaitMs(): number {
  return Math.max(0, Math.trunc(config.proxySessionChannelQueueWaitMs || 0));
}

function getChannelConcurrencyLimit(input?: SessionScopedChannelInput): number {
  if (!isSessionScopedChannel(input)) return 0;
  return Math.max(0, Math.trunc(config.proxySessionChannelConcurrencyLimit || 0));
}

function getOrCreateChannelRuntimeState(channelId: number): ChannelRuntimeState {
  let state = channelRuntimeStates.get(channelId);
  if (!state) {
    state = {
      activeLeaseIds: new Set<number>(),
      queue: [],
    };
    channelRuntimeStates.set(channelId, state);
  }
  return state;
}

function pruneCancelledWaiters(state: ChannelRuntimeState): void {
  if (state.queue.length <= 0) return;
  state.queue = state.queue.filter((waiter) => !waiter.cancelled);
}

function maybeDeleteChannelRuntimeState(channelId: number): void {
  const state = channelRuntimeStates.get(channelId);
  if (!state) return;
  pruneCancelledWaiters(state);
  if (state.activeLeaseIds.size <= 0 && state.queue.every((waiter) => waiter.cancelled)) {
    channelRuntimeStates.delete(channelId);
  }
}

function createNoopLease(channelId: number): ProxyChannelLease {
  return {
    channelId,
    isActive: () => false,
    release: () => {},
    touch: () => {},
  };
}

class ProxyChannelCoordinator {
  buildStickySessionKey(input: {
    clientKind?: string | null;
    sessionId?: string | null;
    requestedModel: string;
    downstreamPath: string;
    downstreamApiKeyId?: number | null;
  }): string | null {
    if (!config.proxyStickySessionEnabled) return null;
    const sessionId = String(input.sessionId || '').trim();
    if (!sessionId) return null;
    const clientKind = String(input.clientKind || 'generic').trim().toLowerCase() || 'generic';
    const owner = typeof input.downstreamApiKeyId === 'number' && Number.isFinite(input.downstreamApiKeyId)
      ? `key:${Math.trunc(input.downstreamApiKeyId)}`
      : 'key:anonymous';
    const stickySessionKey = [owner, clientKind, sessionId].join('|');
    logStickyDiagnostics('build-key', {
      owner,
      clientKind,
      sessionId,
      requestedModel: input.requestedModel,
      downstreamPath: input.downstreamPath,
      stickySessionKey: summarizeStickySessionKey(stickySessionKey),
    });
    return stickySessionKey;
  }

  getStickyChannelId(stickySessionKey?: string | null, nowMs = Date.now()): number | null {
    cleanupExpiredStickyBindings(nowMs);
    const normalizedKey = String(stickySessionKey || '').trim();
    if (!normalizedKey) return null;
    const entry = stickySessionBindings.get(normalizedKey);
    if (!entry || entry.expiresAtMs <= nowMs) {
      if (entry && entry.expiresAtMs <= nowMs) {
        logStickyDiagnostics('lookup-expired', {
          stickySessionKey: summarizeStickySessionKey(normalizedKey),
          channelId: entry.channelId,
          expiresAtMs: entry.expiresAtMs,
          nowMs,
        });
      } else {
        logStickyDiagnostics('lookup-miss', {
          stickySessionKey: summarizeStickySessionKey(normalizedKey),
        });
      }
      stickySessionBindings.delete(normalizedKey);
      return null;
    }
    logStickyDiagnostics('lookup-hit', {
      stickySessionKey: summarizeStickySessionKey(normalizedKey),
      channelId: entry.channelId,
      expiresAtMs: entry.expiresAtMs,
      nowMs,
    });
    return entry.channelId;
  }

  bindStickyChannel(stickySessionKey: string | null | undefined, channelId: number, accountIdentity?: SessionScopedChannelInput): void {
    if (!config.proxyStickySessionEnabled) return;
    if (!canBindStickyChannel(accountIdentity)) return;
    const normalizedKey = String(stickySessionKey || '').trim();
    if (!normalizedKey || !Number.isFinite(channelId) || channelId <= 0) return;
    cleanupExpiredStickyBindings();
    const expiresAtMs = Date.now() + getStickySessionTtlMs();
    stickySessionBindings.set(normalizedKey, {
      channelId: Math.trunc(channelId),
      expiresAtMs,
    });
    this.clearStickyFailureCount(normalizedKey, Math.trunc(channelId));
    logStickyDiagnostics('bind', {
      stickySessionKey: summarizeStickySessionKey(normalizedKey),
      channelId: Math.trunc(channelId),
      expiresAtMs,
      sessionScoped: isSessionScopedChannel(accountIdentity),
    });
  }

  clearStickyChannel(stickySessionKey?: string | null, channelId?: number | null): void {
    const normalizedKey = String(stickySessionKey || '').trim();
    if (!normalizedKey) return;
    const existing = stickySessionBindings.get(normalizedKey);
    if (!existing) return;
    if (typeof channelId === 'number' && Number.isFinite(channelId) && existing.channelId !== Math.trunc(channelId)) {
      logStickyDiagnostics('clear-skip-channel-mismatch', {
        stickySessionKey: summarizeStickySessionKey(normalizedKey),
        expectedChannelId: existing.channelId,
        requestedChannelId: Math.trunc(channelId),
      });
      return;
    }
    stickySessionBindings.delete(normalizedKey);
    this.clearStickyFailureCount(normalizedKey, existing.channelId);
    logStickyDiagnostics('clear', {
      stickySessionKey: summarizeStickySessionKey(normalizedKey),
      channelId: existing.channelId,
    });
  }

  recordStickyFailure(stickySessionKey?: string | null, channelId?: number | null): {
    count: number;
    threshold: number;
    thresholdReached: boolean;
  } {
    const failureKey = buildStickyFailureKey(stickySessionKey, channelId);
    const threshold = getStickyFailureThreshold();
    if (!failureKey) {
      return {
        count: threshold,
        threshold,
        thresholdReached: true,
      };
    }
    cleanupExpiredStickyBindings();
    const previous = stickyFailureCounts.get(failureKey);
    const count = (previous?.count ?? 0) + 1;
    stickyFailureCounts.set(failureKey, {
      count,
      updatedAtMs: Date.now(),
    });
    const thresholdReached = count >= threshold;
    logStickyDiagnostics('failure-count', {
      stickySessionKey: summarizeStickySessionKey(stickySessionKey),
      channelId: Math.trunc(channelId || 0),
      count,
      threshold,
      thresholdReached,
    });
    return {
      count,
      threshold,
      thresholdReached,
    };
  }

  clearStickyFailureCount(stickySessionKey?: string | null, channelId?: number | null): void {
    const failureKey = buildStickyFailureKey(stickySessionKey, channelId);
    if (!failureKey) return;
    const existing = stickyFailureCounts.get(failureKey);
    stickyFailureCounts.delete(failureKey);
    if (existing) {
      logStickyDiagnostics('failure-count-clear', {
        stickySessionKey: summarizeStickySessionKey(stickySessionKey),
        channelId: Math.trunc(channelId || 0),
        count: existing.count,
      });
    }
  }

  getActiveChannelIds(): number[] {
    const ids: number[] = [];
    for (const [channelId, state] of channelRuntimeStates.entries()) {
      pruneCancelledWaiters(state);
      if (state.activeLeaseIds.size > 0) {
        ids.push(channelId);
      }
    }
    return ids;
  }

  getChannelLoadSnapshot(input: {
    channelId: number;
    accountExtraConfig?: string | null;
    accountOauthProvider?: string | null;
  }): ProxyChannelLoadSnapshot {
    const channelId = Math.trunc(input.channelId || 0);
    const sessionScoped = isSessionScopedChannel({
      extraConfig: input.accountExtraConfig,
      oauthProvider: input.accountOauthProvider,
    });
    const concurrencyLimit = getChannelConcurrencyLimit({
      extraConfig: input.accountExtraConfig,
      oauthProvider: input.accountOauthProvider,
    });
    const state = channelId > 0 ? channelRuntimeStates.get(channelId) : null;
    if (state) {
      pruneCancelledWaiters(state);
    }
    const activeLeaseCount = state?.activeLeaseIds.size ?? 0;
    const waitingCount = state?.queue.length ?? 0;
    const denominator = concurrencyLimit > 0 ? concurrencyLimit : 1;
    return {
      channelId,
      sessionScoped,
      concurrencyLimit,
      activeLeaseCount,
      waitingCount,
      loadRatio: (activeLeaseCount + waitingCount) / denominator,
      saturated: concurrencyLimit > 0 && activeLeaseCount >= concurrencyLimit,
    };
  }

  getChannelLoadSnapshots(input: Array<{
    channelId: number;
    accountExtraConfig?: string | null;
    accountOauthProvider?: string | null;
  }>): Map<number, ProxyChannelLoadSnapshot> {
    const snapshots = new Map<number, ProxyChannelLoadSnapshot>();
    for (const item of input) {
      const snapshot = this.getChannelLoadSnapshot(item);
      snapshots.set(snapshot.channelId, snapshot);
    }
    return snapshots;
  }

  async acquireChannelLease(input: {
    channelId: number;
    accountExtraConfig?: string | null;
    accountOauthProvider?: string | null;
  }): Promise<AcquireProxyChannelLeaseResult> {
    const channelId = Math.trunc(input.channelId || 0);
    if (channelId <= 0) {
      return {
        status: 'acquired',
        lease: createNoopLease(0),
      };
    }

    const concurrencyLimit = getChannelConcurrencyLimit({
      extraConfig: input.accountExtraConfig,
      oauthProvider: input.accountOauthProvider,
    });
    if (concurrencyLimit <= 0) {
      return {
        status: 'acquired',
        lease: createNoopLease(channelId),
      };
    }

    const state = getOrCreateChannelRuntimeState(channelId);
    pruneCancelledWaiters(state);
    if (state.activeLeaseIds.size < concurrencyLimit) {
      return {
        status: 'acquired',
        lease: this.createTrackedLease(channelId, state),
      };
    }

    const waitMs = getChannelQueueWaitMs();
    if (waitMs <= 0) {
      return {
        status: 'timeout',
        waitMs: 0,
      };
    }

    return await new Promise<AcquireProxyChannelLeaseResult>((resolve) => {
      const waiter: ChannelWaiter = {
        cancelled: false,
        resolve,
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        waiter.cancelled = true;
        waiter.timer = null;
        pruneCancelledWaiters(state);
        maybeDeleteChannelRuntimeState(channelId);
        resolve({
          status: 'timeout',
          waitMs,
        });
      }, waitMs);
      shouldUnrefTimer(waiter.timer);
      state.queue.push(waiter);
    });
  }

  private createTrackedLease(channelId: number, state: ChannelRuntimeState): ProxyChannelLease {
    const leaseId = nextLeaseId++;
    state.activeLeaseIds.add(leaseId);

    let released = false;
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

    const release = () => {
      if (released) return;
      released = true;
      if (expiryTimer) clearTimeout(expiryTimer);
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      state.activeLeaseIds.delete(leaseId);
      this.drainQueue(channelId);
      maybeDeleteChannelRuntimeState(channelId);
    };

    const touch = () => {
      if (released) return;
      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = setTimeout(() => {
        release();
      }, getChannelLeaseTtlMs());
      shouldUnrefTimer(expiryTimer);
    };

    touch();

    const keepaliveMs = getChannelLeaseKeepaliveMs();
    if (keepaliveMs > 0) {
      keepaliveTimer = setInterval(() => {
        touch();
      }, keepaliveMs);
      shouldUnrefTimer(keepaliveTimer);
    }

    return {
      channelId,
      isActive: () => !released,
      release,
      touch,
    };
  }

  private drainQueue(channelId: number): void {
    const state = channelRuntimeStates.get(channelId);
    if (!state) return;
    pruneCancelledWaiters(state);
    const concurrencyLimit = Math.max(0, Math.trunc(config.proxySessionChannelConcurrencyLimit || 0));
    while (state.activeLeaseIds.size < concurrencyLimit && state.queue.length > 0) {
      const waiter = state.queue.shift();
      if (!waiter || waiter.cancelled) continue;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.timer = null;
      waiter.resolve({
        status: 'acquired',
        lease: this.createTrackedLease(channelId, state),
      });
    }
  }
}

export function resetProxyChannelCoordinatorState(): void {
  stickySessionBindings.clear();
  stickyFailureCounts.clear();
  channelRuntimeStates.clear();
  nextLeaseId = 1;
}

export function isProxyChannelSessionScoped(input?: SessionScopedChannelInput): boolean {
  return isSessionScopedChannel(input);
}

export const proxyChannelCoordinator = new ProxyChannelCoordinator();
