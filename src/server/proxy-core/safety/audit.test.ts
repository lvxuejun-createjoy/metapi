import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeProxySafetyAuditEvent } from './audit.js';
import type { ProxySafetyAuditConfig } from './audit.js';

const baseConfig: ProxySafetyAuditConfig = {
  enabled: true,
  logRequests: true,
  logResponses: true,
  logFullBody: false,
  redactSecrets: true,
  maxBodyChars: 65_536,
  destination: 'console',
  fileDir: './logs/proxy-safety-audit',
  fileSplit: 'daily-direction',
};

describe('proxy safety audit', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('logs summary without full body by default', () => {
    const logger = vi.fn();

    writeProxySafetyAuditEvent({
      config: baseConfig,
      logger,
      event: {
        direction: 'request',
        model: 'claude-test',
        channelId: 12,
        sessionId: 'session-1',
        bodyText: 'OPENAI_API_KEY=sk-secret-value',
        blocked: false,
        findings: [],
      },
    });

    expect(logger).toHaveBeenCalledTimes(1);
    const payload = logger.mock.calls[0]?.[0];
    expect(payload.bodyText).toBeUndefined();
    expect(payload.bodyChars).toBeGreaterThan(0);
    expect(payload.direction).toBe('request');
    expect(payload.sessionId).toBe('session-1');
  });

  it('logs redacted full body only when full body logging is enabled', () => {
    const logger = vi.fn();

    writeProxySafetyAuditEvent({
      config: { ...baseConfig, logFullBody: true },
      logger,
      event: {
        direction: 'request',
        model: 'claude-test',
        channelId: 12,
        bodyText: 'password=supersecret',
        blocked: true,
        findings: [{ ruleId: 'password_assignment', category: 'secret', direction: 'request', message: 'Detected password assignment' }],
      },
    });

    const payload = logger.mock.calls[0]?.[0];
    expect(payload.bodyText).toContain('password=[REDACTED]');
    expect(payload.bodyText).not.toContain('supersecret');
    expect(payload.rules).toEqual(['password_assignment']);
  });

  it('skips response audit when response logging is disabled', () => {
    const logger = vi.fn();

    writeProxySafetyAuditEvent({
      config: { ...baseConfig, logResponses: false },
      logger,
      event: {
        direction: 'response',
        model: 'claude-test',
        channelId: 12,
        bodyText: 'hello',
        blocked: false,
        findings: [],
      },
    });

    expect(logger).not.toHaveBeenCalled();
  });

  it('truncates full body audit after redaction', () => {
    const logger = vi.fn();

    writeProxySafetyAuditEvent({
      config: { ...baseConfig, logFullBody: true, maxBodyChars: 12 },
      logger,
      event: {
        direction: 'response',
        bodyText: 'hello world, this is long',
        blocked: false,
        findings: [],
      },
    });

    const payload = logger.mock.calls[0]?.[0];
    expect(payload.bodyText).toBe('hello world,');
    expect(payload.bodyTruncated).toBe(true);
  });

  it('writes JSONL audit events to daily direction files when file destination is enabled', () => {
    const fileDir = mkdtempSync(join(tmpdir(), 'metapi-safety-audit-'));
    tempDirs.push(fileDir);

    writeProxySafetyAuditEvent({
      config: {
        ...baseConfig,
        destination: 'file',
        fileDir,
        fileSplit: 'daily-direction',
        logFullBody: true,
      },
      now: new Date('2026-07-02T03:04:05.000Z'),
      event: {
        direction: 'request',
        model: 'claude-test',
        channelId: 12,
        bodyText: 'hello',
        blocked: false,
        findings: [],
      },
    });

    const text = readFileSync(join(fileDir, '2026-07-02-request.jsonl'), 'utf8');
    const payload = JSON.parse(text.trim());
    expect(payload.time).toBe('2026-07-02T03:04:05.000Z');
    expect(payload.direction).toBe('request');
    expect(payload.bodyText).toBe('hello');
  });

  it('writes request and response audit events to daily session files', () => {
    const fileDir = mkdtempSync(join(tmpdir(), 'metapi-safety-audit-'));
    tempDirs.push(fileDir);
    const config: ProxySafetyAuditConfig = {
      ...baseConfig,
      destination: 'file',
      fileDir,
      fileSplit: 'daily-session',
      logFullBody: true,
    };

    writeProxySafetyAuditEvent({
      config,
      now: new Date('2026-07-02T03:04:05.000Z'),
      event: {
        direction: 'request',
        model: 'claude-test',
        channelId: 12,
        sessionId: 'af669d36-f9a5-4bb4-82e5-1830e90d3706',
        bodyText: 'request body',
        blocked: false,
        findings: [],
      },
    });
    writeProxySafetyAuditEvent({
      config,
      now: new Date('2026-07-02T03:04:06.000Z'),
      event: {
        direction: 'response',
        model: 'claude-test',
        channelId: 12,
        sessionId: 'af669d36-f9a5-4bb4-82e5-1830e90d3706',
        bodyText: 'response body',
        blocked: false,
        findings: [],
      },
    });

    const text = readFileSync(
      join(fileDir, '2026-07-02', 'session-af669d36-f9a5-4bb4-82e5-1830e90d3706.jsonl'),
      'utf8',
    );
    const payloads = text.trim().split('\n').map((line) => JSON.parse(line));
    expect(payloads).toHaveLength(2);
    expect(payloads.map((payload) => payload.direction)).toEqual(['request', 'response']);
    expect(payloads.map((payload) => payload.sessionId)).toEqual([
      'af669d36-f9a5-4bb4-82e5-1830e90d3706',
      'af669d36-f9a5-4bb4-82e5-1830e90d3706',
    ]);
  });

  it('sanitizes session ids before using them in audit file paths', () => {
    const fileDir = mkdtempSync(join(tmpdir(), 'metapi-safety-audit-'));
    tempDirs.push(fileDir);

    writeProxySafetyAuditEvent({
      config: {
        ...baseConfig,
        destination: 'file',
        fileDir,
        fileSplit: 'daily-session',
        logFullBody: true,
      },
      now: new Date('2026-07-02T03:04:05.000Z'),
      event: {
        direction: 'request',
        sessionId: '../../evil/session',
        bodyText: 'hello',
        blocked: false,
        findings: [],
      },
    });

    expect(readdirSync(fileDir)).toEqual(['2026-07-02']);
    expect(readdirSync(join(fileDir, '2026-07-02'))).toEqual(['session-.._.._evil_session.jsonl']);
  });

  it('supports unlimited full body audit when maxBodyChars is zero', () => {
    const logger = vi.fn();

    writeProxySafetyAuditEvent({
      config: { ...baseConfig, logFullBody: true, maxBodyChars: 0 },
      logger,
      event: {
        direction: 'response',
        bodyText: 'x'.repeat(5000),
        blocked: false,
        findings: [],
      },
    });

    const payload = logger.mock.calls[0]?.[0];
    expect(payload.bodyText).toHaveLength(5000);
    expect(payload.bodyTruncated).toBe(false);
  });
});
