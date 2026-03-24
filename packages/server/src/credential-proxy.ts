/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * Debug exchange capture:
 *   When a debug-subscribed agent has a running container, the proxy
 *   captures POST /v1/messages request+response bodies and emits them
 *   via the onExchange callback. Agent attribution uses the
 *   runningDebugAgents tracking in debug-state.ts.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  hasRunningAgents,
  hasRunningDebugAgents,
  getSingleRunningAgent,
  getSingleRunningDebugAgent,
  nextExchangeIndex,
} from './debug-state.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

/** Callback for captured debug exchanges */
export type OnExchangeFn = (exchange: {
  agentId: string;
  runId: string;
  exchangeIndex: number;
  messagesJson: string;
  responseJson: string;
  tokensIn: number;
  tokensOut: number;
}) => void;

let onExchangeFn: OnExchangeFn = () => {};

export function setOnExchangeFn(fn: OnExchangeFn): void {
  onExchangeFn = fn;
}

/** Callback for token tracking (always called, not just debug) */
export type OnTokensFn = (info: {
  agentId: string;
  runId: string;
  tokensIn: number;
  tokensOut: number;
}) => void;

let onTokensFn: OnTokensFn = () => {};

export function setOnTokensFn(fn: OnTokensFn): void {
  onTokensFn = fn;
}

/**
 * Reconstruct a JSON response from an SSE stream.
 * Anthropic's streaming format sends:
 *   event: message_start  → data: {"type":"message_start","message":{...}}
 *   event: content_block_start/delta/stop → content pieces
 *   event: message_delta  → data: {"type":"message_delta","delta":{...},"usage":{"output_tokens":N}}
 *   event: message_stop
 *
 * We extract the message from message_start, accumulate content block text,
 * and merge usage from message_delta to build a complete response object.
 * Returns null if the input is not SSE.
 */
function extractResponseFromSSE(raw: string): string | null {
  if (!raw.includes('event: message_start')) return null;

  try {
    let message: Record<string, unknown> | null = null;
    const contentBlocks: Record<string, unknown>[] = [];
    let outputTokens = 0;

    // Parse SSE lines
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;

      const parsed = JSON.parse(data);
      switch (parsed.type) {
        case 'message_start':
          message = parsed.message as Record<string, unknown>;
          break;
        case 'content_block_start':
          contentBlocks[parsed.index] = parsed.content_block;
          break;
        case 'content_block_delta':
          if (
            parsed.delta?.type === 'text_delta' &&
            contentBlocks[parsed.index]
          ) {
            const block = contentBlocks[parsed.index] as Record<string, string>;
            block.text = (block.text || '') + parsed.delta.text;
          } else if (
            parsed.delta?.type === 'input_json_delta' &&
            contentBlocks[parsed.index]
          ) {
            const block = contentBlocks[parsed.index] as Record<string, string>;
            block.input = (block.input || '') + parsed.delta.partial_json;
          }
          break;
        case 'message_delta':
          if (parsed.usage?.output_tokens) {
            outputTokens = parsed.usage.output_tokens;
          }
          // Merge stop_reason etc.
          if (message && parsed.delta) {
            Object.assign(message, parsed.delta);
          }
          break;
      }
    }

    if (!message) return null;

    // Assemble the complete message
    message.content = contentBlocks.filter(Boolean);

    // Parse tool_use input strings back to objects
    for (const block of message.content as Record<string, unknown>[]) {
      if (block.type === 'tool_use' && typeof block.input === 'string') {
        try {
          block.input = JSON.parse(block.input as string);
        } catch {
          // Leave as string if not valid JSON
        }
      }
    }

    // Merge usage
    const usage = (message.usage || {}) as Record<string, number>;
    if (outputTokens) usage.output_tokens = outputTokens;
    message.usage = usage;

    return JSON.stringify(message);
  } catch (err) {
    logger.debug({ err }, 'Failed to parse SSE stream for debug capture');
    return null;
  }
}

/** Extract token counts from an API response body */
function extractTokens(responseBody: string): {
  tokensIn: number;
  tokensOut: number;
} {
  try {
    const parsed = JSON.parse(responseBody) as {
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    return {
      tokensIn: parsed.usage?.input_tokens ?? 0,
      tokensOut: parsed.usage?.output_tokens ?? 0,
    };
  } catch {
    return { tokensIn: 0, tokensOut: 0 };
  }
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const reqUrl = req.url || '/';

        // Check if this is a Messages API call.
        // Strip query string before matching — SDKs may append ?beta=... params.
        const urlPath = reqUrl.split('?')[0];
        const isMessagesEndpoint =
          req.method === 'POST' && urlPath.endsWith('/v1/messages');
        // Always capture Messages responses when any agent is running (for token tracking).
        // Debug exchange recording only happens when a debug subscriber is active.
        const shouldCapture = isMessagesEndpoint && hasRunningAgents();
        const shouldRecordDebug = shouldCapture && hasRunningDebugAgents();

        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        // When capturing for debug, disable compression so we can read the
        // SSE stream in plain text. The container's SDK handles uncompressed fine.
        if (shouldCapture) {
          delete headers['accept-encoding'];
        }

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: reqUrl,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            if (shouldCapture) {
              // Tee the response: forward every chunk to the container
              // in real-time while also buffering for token extraction.
              // This preserves SSE streaming for the container's SDK.
              res.writeHead(upRes.statusCode!, upRes.headers);
              const responseChunks: Buffer[] = [];
              upRes.on('data', (chunk: Buffer) => {
                responseChunks.push(chunk);
                res.write(chunk);
              });
              upRes.on('end', () => {
                res.end();

                const rawResponse = Buffer.concat(responseChunks).toString();

                try {
                  const responseJson =
                    extractResponseFromSSE(rawResponse) || rawResponse;
                  const { tokensIn, tokensOut } = extractTokens(responseJson);

                  // Always track tokens for the running agent
                  const target =
                    getSingleRunningDebugAgent() || getSingleRunningAgent();
                  if (target && (tokensIn > 0 || tokensOut > 0)) {
                    onTokensFn({
                      agentId: target.agentId,
                      runId: target.runId,
                      tokensIn,
                      tokensOut,
                    });
                  }

                  // Full exchange capture only when debug is active
                  if (shouldRecordDebug) {
                    const debugTarget = getSingleRunningDebugAgent();
                    if (debugTarget) {
                      const exchangeIndex = nextExchangeIndex(
                        debugTarget.agentId,
                      );
                      logger.debug(
                        {
                          agentId: debugTarget.agentId,
                          runId: debugTarget.runId,
                          exchangeIndex,
                          tokensIn,
                          tokensOut,
                        },
                        'Debug exchange captured',
                      );
                      onExchangeFn({
                        agentId: debugTarget.agentId,
                        runId: debugTarget.runId,
                        exchangeIndex,
                        messagesJson: body.toString(),
                        responseJson,
                        tokensIn,
                        tokensOut,
                      });
                    }
                  }
                } catch (err) {
                  logger.warn({ err }, 'Failed to capture exchange tokens');
                }
              });
            } else {
              // Normal pass-through (no capture needed — not a Messages endpoint)
              res.writeHead(upRes.statusCode!, upRes.headers);
              upRes.pipe(res);
            }
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
