import type { FastifyReply } from 'fastify';
import { config } from '../../config.js';
import { buildSafetyBlockedError, reviewProxyPayload, reviewProxyText, serializeProxySafetyPayload } from './review.js';
import { createProxySafetyStreamReviewer } from './stream.js';
import { writeProxySafetyAuditEvent } from './audit.js';
import type { ProxySafetyConfig, ProxySafetyDirection, ProxySafetyFinding, ProxySafetyVerdict } from './types.js';

export class ProxySafetyBlockedError extends Error {
  readonly direction: ProxySafetyDirection;
  readonly verdict: ProxySafetyVerdict;
  readonly payload: ReturnType<typeof buildSafetyBlockedError>;

  constructor(direction: ProxySafetyDirection, verdict: ProxySafetyVerdict) {
    super('Blocked by proxy safety review');
    this.name = 'ProxySafetyBlockedError';
    this.direction = direction;
    this.verdict = verdict;
    this.payload = buildSafetyBlockedError(direction, verdict);
  }
}

export type ProxySafetySurfaceContext = {
  model?: string | null;
  channelId?: number | null;
  sessionId?: string | null;
};

function getSafetyReviewConfig(): ProxySafetyConfig {
  return {
    enabled: config.proxySafetyReviewEnabled,
    requestEnabled: config.proxySafetyRequestEnabled,
    responseEnabled: config.proxySafetyResponseEnabled,
    blockSecrets: config.proxySafetyBlockSecrets,
    blockEnvFiles: config.proxySafetyBlockEnvFiles,
    blockDangerousCommands: config.proxySafetyBlockDangerousCommands,
  };
}

function writeAudit(input: {
  direction: ProxySafetyDirection;
  context: ProxySafetySurfaceContext;
  bodyText: string;
  blocked: boolean;
  findings: ProxySafetyFinding[];
}): void {
  writeProxySafetyAuditEvent({
    config: {
      enabled: config.proxySafetyAuditEnabled,
      logRequests: config.proxySafetyAuditLogRequests,
      logResponses: config.proxySafetyAuditLogResponses,
      logFullBody: config.proxySafetyAuditLogFullBody,
      redactSecrets: config.proxySafetyAuditRedactSecrets,
      maxBodyChars: config.proxySafetyAuditMaxBodyChars,
      destination: config.proxySafetyAuditDestination,
      fileDir: config.proxySafetyAuditFileDir,
      fileSplit: config.proxySafetyAuditFileSplit,
    },
    event: {
      direction: input.direction,
      model: input.context.model ?? null,
      channelId: input.context.channelId ?? null,
      sessionId: input.context.sessionId ?? null,
      bodyText: input.bodyText,
      blocked: input.blocked,
      findings: input.findings,
    },
  });
}

export function reviewSurfaceRequestPayload(payload: unknown, context: ProxySafetySurfaceContext): void {
  const bodyText = serializeProxySafetyPayload(payload);
  const verdict = reviewProxyPayload('request', payload, getSafetyReviewConfig());
  writeAudit({
    direction: 'request',
    context,
    bodyText,
    blocked: !verdict.allowed,
    findings: verdict.findings,
  });
  if (!verdict.allowed) {
    throw new ProxySafetyBlockedError('request', verdict);
  }
}

export function reviewSurfaceResponseText(text: string, context: ProxySafetySurfaceContext): void {
  const verdict = reviewProxyText('response', text, getSafetyReviewConfig());
  writeAudit({
    direction: 'response',
    context,
    bodyText: text,
    blocked: !verdict.allowed,
    findings: verdict.findings,
  });
  if (!verdict.allowed) {
    throw new ProxySafetyBlockedError('response', verdict);
  }
}

export function sendSafetyBlockedReply(reply: FastifyReply, error: ProxySafetyBlockedError) {
  return reply.code(403).send(error.payload);
}

export function writeSafetyBlockedSse(reply: FastifyReply, error: ProxySafetyBlockedError): void {
  reply.raw.write(`event: error\ndata: ${JSON.stringify(error.payload)}\n\n`);
}

export function createSurfaceSafetyStreamGuard(context: ProxySafetySurfaceContext) {
  const reviewer = createProxySafetyStreamReviewer({
    config: getSafetyReviewConfig(),
    windowChars: config.proxySafetyStreamWindowChars,
  });
  let fullText = '';
  let blockedError: ProxySafetyBlockedError | null = null;

  return {
    reviewChunk(chunkText: string): void {
      fullText += chunkText;
      const verdict = reviewer.reviewChunk(chunkText);
      if (!verdict.allowed) {
        writeAudit({
          direction: 'response',
          context,
          bodyText: fullText,
          blocked: true,
          findings: verdict.findings,
        });
        blockedError = new ProxySafetyBlockedError('response', verdict);
        throw blockedError;
      }
    },
    flushAllowed(): void {
      writeAudit({
        direction: 'response',
        context,
        bodyText: fullText,
        blocked: false,
        findings: [],
      });
    },
    getText(): string {
      return fullText;
    },
    getBlockedError(): ProxySafetyBlockedError | null {
      return blockedError;
    },
  };
}
