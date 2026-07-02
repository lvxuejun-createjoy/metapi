import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ProxySafetyDirection, ProxySafetyFinding } from './types.js';

export type ProxySafetyAuditDestination = 'console' | 'file' | 'both';
export type ProxySafetyAuditFileSplit = 'daily' | 'daily-direction' | 'daily-session';

export type ProxySafetyAuditConfig = {
  enabled: boolean;
  logRequests: boolean;
  logResponses: boolean;
  logFullBody: boolean;
  redactSecrets: boolean;
  maxBodyChars: number;
  destination: ProxySafetyAuditDestination;
  fileDir: string;
  fileSplit: ProxySafetyAuditFileSplit;
};

export type ProxySafetyAuditEvent = {
  direction: ProxySafetyDirection;
  model?: string | null;
  channelId?: number | null;
  sessionId?: string | null;
  bodyText: string;
  blocked: boolean;
  findings: ProxySafetyFinding[];
};

export type ProxySafetyAuditPayload = {
  event: 'proxy_safety_audit';
  direction: ProxySafetyDirection;
  model?: string | null;
  channelId?: number | null;
  sessionId?: string | null;
  bodyChars: number;
  bodyText?: string;
  bodyTruncated?: boolean;
  blocked: boolean;
  rules: string[];
  time?: string;
};

function shouldLogDirection(config: ProxySafetyAuditConfig, direction: ProxySafetyDirection): boolean {
  if (!config.enabled) return false;
  if (direction === 'request') return config.logRequests;
  return config.logResponses;
}

function redactAuditText(text: string): string {
  return text
    .replace(/\b(password|passwd|pwd)\s*[:=]\s*(['"]?)[^'"\s,}]+/gi, '$1=$2[REDACTED]')
    .replace(/\b(Authorization\s*:\s*Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/(-----BEGIN (?:OPENSSH|RSA|DSA|EC|PRIVATE) PRIVATE KEY-----)[\s\S]*?(-----END (?:OPENSSH|RSA|DSA|EC|PRIVATE) PRIVATE KEY-----)/g, '$1[REDACTED]$2')
    .replace(/\b([A-Z][A-Z0-9_]{2,})\s*=\s*(sk-[A-Za-z0-9_-]{8,}|postgres(?:ql)?:\/\/\S+|mysql:\/\/\S+|mongodb(?:\+srv)?:\/\/\S+|redis:\/\/\S+)/g, '$1=[REDACTED]');
}

export function buildProxySafetyAuditPayload(input: {
  config: ProxySafetyAuditConfig;
  event: ProxySafetyAuditEvent;
}): ProxySafetyAuditPayload | null {
  const { config, event } = input;
  if (!shouldLogDirection(config, event.direction)) return null;

  const payload: ProxySafetyAuditPayload = {
    event: 'proxy_safety_audit',
    direction: event.direction,
    model: event.model ?? null,
    channelId: event.channelId ?? null,
    sessionId: event.sessionId ?? null,
    bodyChars: event.bodyText.length,
    blocked: event.blocked,
    rules: event.findings.map((finding) => finding.ruleId),
  };

  if (!config.logFullBody) return payload;

  const fullText = config.redactSecrets ? redactAuditText(event.bodyText) : event.bodyText;
  const maxChars = Math.max(0, Math.trunc(config.maxBodyChars));
  payload.bodyText = maxChars === 0 ? fullText : fullText.slice(0, maxChars);
  payload.bodyTruncated = maxChars > 0 && fullText.length > maxChars;
  return payload;
}

function buildAuditFileName(input: {
  time: Date;
  direction: ProxySafetyDirection;
  sessionId?: string | null;
  split: ProxySafetyAuditFileSplit;
}): string {
  const day = input.time.toISOString().slice(0, 10);
  if (input.split === 'daily-direction') return `${day}-${input.direction}.jsonl`;
  if (input.split === 'daily-session') return join(day, `session-${sanitizeAuditFileSegment(input.sessionId || 'unknown')}.jsonl`);
  return `${day}.jsonl`;
}

function sanitizeAuditFileSegment(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized || 'unknown';
}

function writeAuditPayloadToFile(input: {
  config: ProxySafetyAuditConfig;
  payload: ProxySafetyAuditPayload;
  now: Date;
}): void {
  const fileDir = resolve(input.config.fileDir || './logs/proxy-safety-audit');
  mkdirSync(fileDir, { recursive: true });
  const fileName = buildAuditFileName({
    time: input.now,
    direction: input.payload.direction,
    sessionId: input.payload.sessionId,
    split: input.config.fileSplit,
  });
  const filePath = resolve(fileDir, fileName);
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(input.payload)}\n`, 'utf8');
}

export function writeProxySafetyAuditEvent(input: {
  config: ProxySafetyAuditConfig;
  logger?: (payload: ProxySafetyAuditPayload) => void;
  event: ProxySafetyAuditEvent;
  now?: Date;
}): void {
  const now = input.now ?? new Date();
  const payload = buildProxySafetyAuditPayload(input);
  if (!payload) return;
  payload.time = now.toISOString();
  const logger = input.logger ?? ((auditPayload) => console.info('[proxy-safety-audit]', auditPayload));
  if (input.config.destination === 'console' || input.config.destination === 'both') {
    logger(payload);
  }
  if (input.config.destination === 'file' || input.config.destination === 'both') {
    writeAuditPayloadToFile({
      config: input.config,
      payload,
      now,
    });
  }
}
