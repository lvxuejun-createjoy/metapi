import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildConfig, buildFastifyOptions } from './config.js';

describe('buildConfig', () => {
  it('enables channel recovery probes by default and accepts an environment override', () => {
    expect(buildConfig({}).channelRecoveryProbeEnabled).toBe(true);
    expect(buildConfig({ CHANNEL_RECOVERY_PROBE_ENABLED: 'false' }).channelRecoveryProbeEnabled).toBe(false);
  });

  it('defaults to external listen host for server deployments', () => {
    const config = buildConfig({});

    expect(config.listenHost).toBe('0.0.0.0');
    expect(config.port).toBe(4000);
    expect(config.dataDir).toBe('./data');
  });

  it('aligns desktop deployments with server deployments for listen host', () => {
    const config = buildConfig({
      HOST: '0.0.0.0',
      METAPI_DESKTOP: '1',
      PORT: '4312',
      DATA_DIR: '/tmp/metapi-data',
    });

    expect(config.listenHost).toBe('0.0.0.0');
    expect(config.port).toBe(4312);
    expect(config.dataDir).toBe('/tmp/metapi-data');
  });

  it('honors explicit loopback host outside desktop mode', () => {
    const config = buildConfig({
      HOST: '127.0.0.1',
    });

    expect(config.listenHost).toBe('127.0.0.1');
  });

  it('defaults telegram api base url to the official endpoint', () => {
    const config = buildConfig({});

    expect(config.telegramApiBaseUrl).toBe('https://api.telegram.org');
    expect(config.telegramMessageThreadId).toBe('');
  });

  it('defaults sticky failure threshold to five and allows overriding it', () => {
    expect(buildConfig({}).proxyStickyFailureThreshold).toBe(5);
    expect(buildConfig({
      PROXY_STICKY_FAILURE_THRESHOLD: '7',
    }).proxyStickyFailureThreshold).toBe(7);
    expect(buildConfig({
      PROXY_STICKY_FAILURE_THRESHOLD: '0',
    }).proxyStickyFailureThreshold).toBe(1);
  });

  it('defaults site api endpoint failure threshold to five and allows overriding it', () => {
    expect(buildConfig({}).siteApiEndpointFailureThreshold).toBe(5);
    expect(buildConfig({
      SITE_API_ENDPOINT_FAILURE_THRESHOLD: '7',
    }).siteApiEndpointFailureThreshold).toBe(7);
    expect(buildConfig({
      SITE_API_ENDPOINT_FAILURE_THRESHOLD: '0',
    }).siteApiEndpointFailureThreshold).toBe(1);
  });

  it('defaults proxy safety review and audit to safe disabled defaults', () => {
    const config = buildConfig({});

    expect(config.proxySafetyReviewEnabled).toBe(false);
    expect(config.proxySafetyRequestEnabled).toBe(true);
    expect(config.proxySafetyResponseEnabled).toBe(true);
    expect(config.proxySafetyBlockSecrets).toBe(true);
    expect(config.proxySafetyBlockEnvFiles).toBe(true);
    expect(config.proxySafetyBlockDangerousCommands).toBe(true);
    expect(config.proxySafetyStreamWindowChars).toBe(8192);
    expect(config.proxySafetyAuditEnabled).toBe(false);
    expect(config.proxySafetyAuditLogRequests).toBe(true);
    expect(config.proxySafetyAuditLogResponses).toBe(true);
    expect(config.proxySafetyAuditLogFullBody).toBe(false);
    expect(config.proxySafetyAuditRedactSecrets).toBe(true);
    expect(config.proxySafetyAuditMaxBodyChars).toBe(65536);
    expect(config.proxySafetyAuditDestination).toBe('console');
    expect(config.proxySafetyAuditFileDir).toBe('./logs/proxy-safety-audit');
    expect(config.proxySafetyAuditFileSplit).toBe('daily-session');
  });

  it('accepts proxy safety review and audit overrides', () => {
    const config = buildConfig({
      PROXY_SAFETY_REVIEW_ENABLED: 'true',
      PROXY_SAFETY_REVIEW_REQUEST_ENABLED: 'false',
      PROXY_SAFETY_REVIEW_RESPONSE_ENABLED: 'false',
      PROXY_SAFETY_REVIEW_BLOCK_SECRETS: 'false',
      PROXY_SAFETY_REVIEW_BLOCK_ENV_FILES: 'false',
      PROXY_SAFETY_REVIEW_BLOCK_DANGEROUS_COMMANDS: 'false',
      PROXY_SAFETY_REVIEW_STREAM_WINDOW_CHARS: '4096',
      PROXY_SAFETY_AUDIT_ENABLED: 'true',
      PROXY_SAFETY_AUDIT_LOG_REQUESTS: 'false',
      PROXY_SAFETY_AUDIT_LOG_RESPONSES: 'false',
      PROXY_SAFETY_AUDIT_LOG_FULL_BODY: 'true',
      PROXY_SAFETY_AUDIT_REDACT_SECRETS: 'false',
      PROXY_SAFETY_AUDIT_MAX_BODY_CHARS: '0',
      PROXY_SAFETY_AUDIT_DESTINATION: 'file',
      PROXY_SAFETY_AUDIT_FILE_DIR: './tmp/safety-audit',
      PROXY_SAFETY_AUDIT_FILE_SPLIT: 'daily-session',
    });

    expect(config.proxySafetyReviewEnabled).toBe(true);
    expect(config.proxySafetyRequestEnabled).toBe(false);
    expect(config.proxySafetyResponseEnabled).toBe(false);
    expect(config.proxySafetyBlockSecrets).toBe(false);
    expect(config.proxySafetyBlockEnvFiles).toBe(false);
    expect(config.proxySafetyBlockDangerousCommands).toBe(false);
    expect(config.proxySafetyStreamWindowChars).toBe(4096);
    expect(config.proxySafetyAuditEnabled).toBe(true);
    expect(config.proxySafetyAuditLogRequests).toBe(false);
    expect(config.proxySafetyAuditLogResponses).toBe(false);
    expect(config.proxySafetyAuditLogFullBody).toBe(true);
    expect(config.proxySafetyAuditRedactSecrets).toBe(false);
    expect(config.proxySafetyAuditMaxBodyChars).toBe(0);
    expect(config.proxySafetyAuditDestination).toBe('file');
    expect(config.proxySafetyAuditFileDir).toBe('./tmp/safety-audit');
    expect(config.proxySafetyAuditFileSplit).toBe('daily-session');
  });

  it('accepts telegram message thread id from environment', () => {
    const config = buildConfig({
      TELEGRAM_MESSAGE_THREAD_ID: '77',
    });

    expect(config.telegramMessageThreadId).toBe('77');
  });

  it('ships CLI-aligned OAuth defaults', () => {
    const config = buildConfig({});

    expect(config.codexClientId).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(config.codexResponsesWebsocketBeta).toBe('responses_websockets=2026-02-06');
    expect(config.claudeClientId).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    expect(config.claudeClientSecret).toBe('');
    expect(config.geminiCliClientId).toBe('681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com');
    expect(config.geminiCliClientSecret).toBe('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');
  });

  it('allows overriding the codex websocket beta gate from environment', () => {
    const config = buildConfig({
      CODEX_RESPONSES_WEBSOCKET_BETA: 'responses_websockets=2099-01-01',
    });

    expect(config.codexResponsesWebsocketBeta).toBe('responses_websockets=2099-01-01');
  });

  it('accepts JSON request bodies larger than Fastify default 1 MiB', async () => {
    const app = Fastify(buildFastifyOptions(buildConfig({})));
    const largeText = 'a'.repeat(2 * 1024 * 1024);

    app.post('/echo', async (request) => {
      const body = request.body as { text?: string };
      return { textLength: body.text?.length ?? 0 };
    });

    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      payload: { text: largeText },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ textLength: largeText.length });
    await app.close();
  });

  it('trusts forwarded client IP headers for reverse-proxy deployments', async () => {
    const app = Fastify(buildFastifyOptions(buildConfig({})));

    app.get('/ip', async (request) => ({
      ip: request.ip,
    }));

    const response = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '10.0.0.8',
      headers: {
        'x-forwarded-for': '203.0.113.5, 10.0.0.8',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ip: '203.0.113.5' });
    await app.close();
  });
});
