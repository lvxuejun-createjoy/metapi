import type { RuntimeHealthState } from './accountHealthService.js';
import { getCredentialModeFromExtraConfig } from './accountExtraConfig.js';

export type ModelRefreshErrorCode = 'timeout' | 'unauthorized' | 'empty_models' | 'unknown';

function looksLikeHtmlJsonParseError(message: string): boolean {
  const lowered = String(message || '').trim().toLowerCase();
  return (
    lowered.includes('unexpected token')
    && lowered.includes('not valid json')
    && (lowered.includes('<html') || lowered.includes('<script'))
  );
}

function looksLikeShieldChallenge(message: string): boolean {
  const lowered = String(message || '').trim().toLowerCase();
  return (
    lowered.includes('acw_sc__v2')
    || lowered.includes('var arg1')
    || lowered.includes('captcha')
    || lowered.includes('challenge')
    || lowered.includes('cloudflare tunnel error')
  );
}

export function isExplicitApiKeyCredentialFailure(message?: string | null): boolean {
  const text = String(message || '').trim().toLowerCase();
  if (!text) return false;
  return /\binvalid\s+api\s+key\b/.test(text)
    || /\bapi\s+key\s+expired\b/.test(text)
    || /\binvalid\s+access\s+token\b/.test(text);
}

export function classifyModelDiscoveryError(message: string): ModelRefreshErrorCode {
  const lowered = message.toLowerCase();
  if (
    lowered.includes('timeout')
    || lowered.includes('timed out')
    || lowered.includes('请求超时')
    || lowered.includes('etimedout')
    || lowered.includes('econnreset')
    || lowered.includes('econnrefused')
    || lowered.includes('socket hang up')
    || lowered.includes('fetch failed')
    || lowered.includes('network error')
    || lowered.includes('http 502')
    || lowered.includes('http 503')
    || lowered.includes('http 504')
  ) return 'timeout';
  if (lowered.includes('http 401') || lowered.includes('http 403')
    || lowered.includes('unauthorized') || lowered.includes('invalid')
    || lowered.includes('无权') || lowered.includes('未提供令牌')) return 'unauthorized';
  return 'unknown';
}

export function buildModelFailureMessage(code: ModelRefreshErrorCode, fallback?: string, platform?: string | null) {
  const raw = String(fallback || '').trim();
  if (looksLikeHtmlJsonParseError(raw) || looksLikeShieldChallenge(raw)) {
    const normalizedPlatform = String(platform || '').trim().toLowerCase();
    if (normalizedPlatform === 'new-api' || normalizedPlatform === 'anyrouter') {
      return '模型获取失败：站点返回了防护页面，请在目标站点创建 API Key 后再同步模型';
    }
    return '模型获取失败：站点返回了网页而不是 JSON 响应';
  }
  if (code === 'timeout') return '模型获取失败（请求超时）';
  if (code === 'unauthorized') {
    return isExplicitApiKeyCredentialFailure(raw)
      ? '模型获取失败，API Key 已无效'
      : (raw || '模型获取失败：认证请求失败');
  }
  if (code === 'empty_models') return '模型获取失败：未获取到可用模型';
  return fallback || '模型获取失败';
}

export function resolveModelDiscoveryRuntimeHealthState(input: {
  accountExtraConfig?: string | Record<string, unknown> | null;
  errorCode: ModelRefreshErrorCode;
  errorMessage?: string | null;
  rawErrorMessage?: string | null;
}): RuntimeHealthState {
  const credentialMode = getCredentialModeFromExtraConfig(input.accountExtraConfig);
  if (credentialMode !== 'apikey') return 'unhealthy';

  const message = input.rawErrorMessage || input.errorMessage || '';
  if (input.errorCode === 'unauthorized' && isExplicitApiKeyCredentialFailure(message)) {
    return 'unhealthy';
  }

  return 'degraded';
}
