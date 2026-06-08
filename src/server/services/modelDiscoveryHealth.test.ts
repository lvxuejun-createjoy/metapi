import { describe, expect, it } from 'vitest';

import {
  buildModelFailureMessage,
  classifyModelDiscoveryError,
  resolveModelDiscoveryRuntimeHealthState,
} from './modelDiscoveryHealth.js';

describe('modelDiscoveryHealth', () => {
  it('marks API key network and temporary discovery failures as degraded', () => {
    const errorCode = classifyModelDiscoveryError('fetch failed: ETIMEDOUT');
    const errorMessage = buildModelFailureMessage(errorCode, 'fetch failed: ETIMEDOUT', 'new-api');

    expect(errorCode).toBe('timeout');
    expect(errorMessage).toBe('模型获取失败（请求超时）');
    expect(resolveModelDiscoveryRuntimeHealthState({
      accountExtraConfig: { credentialMode: 'apikey' },
      errorCode,
      errorMessage,
      rawErrorMessage: 'fetch failed: ETIMEDOUT',
    })).toBe('degraded');
  });

  it('keeps explicit API key credential failures unhealthy', () => {
    const errorCode = classifyModelDiscoveryError('HTTP 401: invalid api key');
    const errorMessage = buildModelFailureMessage(errorCode, 'HTTP 401: invalid api key', 'new-api');

    expect(errorCode).toBe('unauthorized');
    expect(errorMessage).toBe('模型获取失败，API Key 已无效');
    expect(resolveModelDiscoveryRuntimeHealthState({
      accountExtraConfig: { credentialMode: 'apikey' },
      errorCode,
      errorMessage,
      rawErrorMessage: 'HTTP 401: invalid api key',
    })).toBe('unhealthy');
  });

  it('keeps non API key discovery failures unhealthy', () => {
    expect(resolveModelDiscoveryRuntimeHealthState({
      accountExtraConfig: { credentialMode: 'session' },
      errorCode: 'timeout',
      errorMessage: '模型获取失败（请求超时）',
      rawErrorMessage: 'model discovery timeout',
    })).toBe('unhealthy');
  });
});
