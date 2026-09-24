import http from 'node:http';
import https from 'node:https';

import { formatErrorMessage } from '../shared/format-utils';
import { CLEANUP_TIMEOUT_MS, type JsonRequestOptions, MAX_RESPONSE_BYTES } from './http-shared';
import { ProviderError } from './provider';

const MAX_ERROR_BODY_BYTES = 8 * 1024;

/** CORS-free JSON transport for validated desktop-only custom endpoints. */
export async function nodeHttpJson(
  url: string,
  init: RequestInit = {},
  options: JsonRequestOptions = {},
): Promise<unknown> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProviderError('Custom provider URL must use HTTP or HTTPS.', 'connection_failed');
  }

  const timeoutMs = options.timeoutMs ?? CLEANUP_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const body = toRequestBody(init.body);
  const headers = requestHeaders(init.headers, body !== undefined);
  const transport = parsed.protocol === 'https:' ? https : http;

  return await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let request: http.ClientRequest;
    let response: http.IncomingMessage | null = null;
    let timeoutId: number | null = null;

    const cleanup = (): void => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      options.abortSignal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      response?.destroy();
      request.destroy();
      reject(normalizeNodeHttpError(error, options.abortSignal, timedOut, timeoutMs));
    };
    const succeed = (value: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onAbort = (): void => {
      fail(new ProviderError('Provider request aborted.', 'aborted'));
    };

    request = transport.request(
      {
        headers,
        hostname: parsed.hostname,
        method: init.method ?? 'GET',
        path: `${parsed.pathname}${parsed.search}`,
        port: parsed.port,
        protocol: parsed.protocol,
      },
      (incoming) => {
        response = incoming;
        const status = incoming.statusCode ?? 0;
        const contentLength = Number(incoming.headers['content-length']);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          fail(
            new ProviderError(`Provider response exceeded ${maxBytes} bytes.`, 'invalid_response'),
          );
          return;
        }

        const captureLimit = status >= 200 && status < 300 ? maxBytes : MAX_ERROR_BODY_BYTES;
        const chunks: Buffer[] = [];
        let capturedBytes = 0;
        let totalBytes = 0;
        incoming.on('data', (chunk: Buffer | string) => {
          if (settled) return;
          const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          totalBytes += bytes.byteLength;
          if (totalBytes > maxBytes) {
            fail(
              new ProviderError(
                `Provider response exceeded ${maxBytes} bytes.`,
                'invalid_response',
              ),
            );
            return;
          }
          if (capturedBytes < captureLimit) {
            const retained = bytes.subarray(0, captureLimit - capturedBytes);
            chunks.push(retained);
            capturedBytes += retained.byteLength;
          }
        });
        incoming.on('error', fail);
        incoming.on('end', () => {
          if (settled) return;
          const responseText = Buffer.concat(chunks, totalBytes).toString('utf8');
          if (status < 200 || status >= 300) {
            fail(
              new ProviderError(`Provider returned HTTP ${status}.`, 'http_error', {
                responseText: responseText.slice(0, MAX_ERROR_BODY_BYTES),
                status,
              }),
            );
            return;
          }
          try {
            succeed(JSON.parse(responseText));
          } catch (error) {
            fail(
              new ProviderError(
                `Provider returned malformed JSON: ${formatErrorMessage(error)}`,
                'invalid_response',
              ),
            );
          }
        });
      },
    );

    options.abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (options.abortSignal?.aborted === true) {
      onAbort();
      return;
    }
    timeoutId = window.setTimeout(() => {
      timedOut = true;
      fail(new ProviderError(`Provider request timed out after ${timeoutMs}ms.`, 'timeout'));
    }, timeoutMs);
    request.on('error', fail);
    request.end(body);
  });
}

function requestHeaders(init: HeadersInit | undefined, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  new Headers(init).forEach((value, key) => {
    headers[key] = value;
  });
  if (hasBody && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json';
  }
  return headers;
}

function toRequestBody(body: BodyInit | null | undefined): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new ProviderError('Provider request body type is unsupported.', 'connection_failed');
}

function normalizeNodeHttpError(
  error: unknown,
  signal: AbortSignal | undefined,
  timedOut: boolean,
  timeoutMs: number,
): ProviderError {
  if (error instanceof ProviderError) return error;
  if (signal?.aborted === true) return new ProviderError('Provider request aborted.', 'aborted');
  if (timedOut) {
    return new ProviderError(`Provider request timed out after ${timeoutMs}ms.`, 'timeout');
  }
  return new ProviderError(
    `Failed to reach provider: ${formatErrorMessage(error)}`,
    'connection_failed',
  );
}
