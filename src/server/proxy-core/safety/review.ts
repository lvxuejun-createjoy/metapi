import { PROXY_SAFETY_RULES } from './rules.js';
import type {
  ProxySafetyConfig,
  ProxySafetyDirection,
  ProxySafetyRule,
  ProxySafetyVerdict,
} from './types.js';

function isCategoryEnabled(rule: ProxySafetyRule, config: ProxySafetyConfig): boolean {
  if (rule.category === 'secret') return config.blockSecrets;
  if (rule.category === 'env_file') return config.blockEnvFiles;
  if (rule.category === 'dangerous_command') return config.blockDangerousCommands;
  return false;
}

function isDirectionEnabled(direction: ProxySafetyDirection, config: ProxySafetyConfig): boolean {
  if (!config.enabled) return false;
  if (direction === 'request') return config.requestEnabled;
  return config.responseEnabled;
}

function stringifyPayload(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? '');
  }
}

function collectPayloadStrings(value: unknown, output: string[], seen = new WeakSet<object>()): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectPayloadStrings(item, output, seen);
    return;
  }
  for (const item of Object.values(value)) collectPayloadStrings(item, output, seen);
}

export function reviewProxyText(
  direction: ProxySafetyDirection,
  text: string,
  config: ProxySafetyConfig,
): ProxySafetyVerdict {
  if (!text || !isDirectionEnabled(direction, config)) {
    return { allowed: true, findings: [] };
  }

  const findings = PROXY_SAFETY_RULES
    .filter((rule) => rule.directions.includes(direction) && isCategoryEnabled(rule, config))
    .filter((rule) => rule.pattern.test(text))
    .map((rule) => ({
      ruleId: rule.id,
      category: rule.category,
      direction,
      message: rule.message,
    }));

  return {
    allowed: findings.length === 0,
    findings,
  };
}

export function reviewProxyPayload(
  direction: ProxySafetyDirection,
  payload: unknown,
  config: ProxySafetyConfig,
): ProxySafetyVerdict {
  const strings: string[] = [];
  collectPayloadStrings(payload, strings);
  const text = strings.length > 0
    ? strings.join('\n')
    : stringifyPayload(payload);
  return reviewProxyText(direction, text, config);
}

export function buildSafetyBlockedError(direction: ProxySafetyDirection, verdict: ProxySafetyVerdict) {
  const firstFinding = verdict.findings[0];
  return {
    error: {
      message: 'Blocked by proxy safety review',
      type: 'safety_review_blocked',
      direction,
      rule: firstFinding?.ruleId || 'unknown',
    },
  };
}

export function serializeProxySafetyPayload(payload: unknown): string {
  return stringifyPayload(payload);
}
