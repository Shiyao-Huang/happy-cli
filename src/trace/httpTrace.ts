import axios, { AxiosHeaders, type AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { emitTraceEvent } from './traceEmitter';
import { generateTraceId, getTraceContext } from './traceId';
import { TraceEventKind } from './traceTypes';

export const AHA_TRACE_HEADERS = {
  traceId: 'x-aha-trace-id',
  spanId: 'x-aha-span-id',
  parentSpanId: 'x-aha-parent-span-id',
  requestId: 'x-aha-request-id',
  sessionId: 'x-aha-session-id',
  machineId: 'x-aha-machine-id',
  teamId: 'x-aha-team-id',
  taskId: 'x-aha-task-id',
} as const;

type TraceAxiosConfig = InternalAxiosRequestConfig & {
  ahaTraceMeta?: {
    traceId: string;
    requestId: string;
    startedAt: number;
    url: string;
    method: string;
  };
};

let axiosInstalled = false;
let fetchInstalled = false;

function headerValue(headers: AxiosHeaders, name: string): string | null {
  const value = headers.get(name);
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function normalizeUrl(config: InternalAxiosRequestConfig): string {
  const rawUrl = config.url ?? '';
  const rawBase = config.baseURL;

  try {
    const url = rawBase ? new URL(rawUrl, rawBase) : new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return rawUrl.split('?')[0] || 'unknown';
  }
}

function normalizeMethod(config: InternalAxiosRequestConfig): string {
  return (config.method ?? 'GET').toUpperCase();
}

function shouldTraceUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl, 'http://localhost');
    const host = url.hostname.toLowerCase();
    const path = url.pathname;
    const isKnownAhaHost = host === 'localhost'
      || host === '127.0.0.1'
      || host.endsWith('aha-agi.com')
      || host.endsWith('aha.engineering')
      || host.endsWith('aha-agi.com');
    const isKnownAhaPort = url.port === '3005' || url.port === '3006';
    const isKnownAhaPath = path.startsWith('/api/v1/')
      || path === '/api/v1'
      || path.startsWith('/v1/')
      || path === '/v1'
      || path.startsWith('/genomes')
      || path.startsWith('/genome/genomes')
      || path.startsWith('/entities')
      || path.startsWith('/genome/entities')
      || path.startsWith('/corps')
      || path.startsWith('/genome/corps')
      || path.startsWith('/permissions')
      || path.startsWith('/genome/permissions')
      || path.startsWith('/blobs')
      || path.startsWith('/genome/blobs')
      || path.startsWith('/trials')
      || path.startsWith('/genome/trials');

    return isKnownAhaPath && (isKnownAhaHost || isKnownAhaPort || rawUrl.startsWith('/'));
  } catch {
    return false;
  }
}

function summarizeError(error: AxiosError): string {
  if (error.response) {
    return `HTTP ${error.response.status}`;
  }
  return error.code ?? error.message ?? 'HTTP request failed';
}

export function buildAhaTraceHeaders(input?: {
  traceId?: string | null;
  parentSpanId?: string | null;
  requestId?: string | null;
  sessionId?: string | null;
  machineId?: string | null;
  teamId?: string | null;
  taskId?: string | null;
}): Record<string, string> {
  const traceId = input?.traceId?.trim() || getTraceContext();
  const spanId = generateTraceId();
  const requestId = input?.requestId?.trim() || generateTraceId();

  return {
    [AHA_TRACE_HEADERS.traceId]: traceId,
    [AHA_TRACE_HEADERS.spanId]: spanId,
    ...(input?.parentSpanId ? { [AHA_TRACE_HEADERS.parentSpanId]: input.parentSpanId } : {}),
    [AHA_TRACE_HEADERS.requestId]: requestId,
    ...(input?.sessionId ? { [AHA_TRACE_HEADERS.sessionId]: input.sessionId } : {}),
    ...(input?.machineId ? { [AHA_TRACE_HEADERS.machineId]: input.machineId } : {}),
    ...(input?.teamId ? { [AHA_TRACE_HEADERS.teamId]: input.teamId } : {}),
    ...(input?.taskId ? { [AHA_TRACE_HEADERS.taskId]: input.taskId } : {}),
  };
}

function emitHttpTrace(response: AxiosResponse, failed: boolean): void {
  const config = response.config as TraceAxiosConfig;
  const meta = config.ahaTraceMeta;
  if (!meta) {
    return;
  }

  const durationMs = Date.now() - meta.startedAt;
  const status = response.status;
  emitTraceEvent(
    failed ? TraceEventKind.http_request_failed : TraceEventKind.http_request_completed,
    'http-client',
    { trace_id: meta.traceId },
    `${meta.method} ${meta.url} -> ${status}`,
    {
      level: failed ? 'warn' : 'debug',
      status: failed ? 'failed' : 'ok',
      attrs: {
        method: meta.method,
        url: meta.url,
        status,
        durationMs,
        requestId: meta.requestId,
      },
    },
  );
}

function emitHttpErrorTrace(error: AxiosError): void {
  const config = error.config as TraceAxiosConfig | undefined;
  const meta = config?.ahaTraceMeta;
  if (!meta) {
    return;
  }

  const durationMs = Date.now() - meta.startedAt;
  const responseStatus = error.response?.status;
  emitTraceEvent(
    TraceEventKind.http_request_failed,
    'http-client',
    { trace_id: meta.traceId },
    `${meta.method} ${meta.url} -> ${summarizeError(error)}`,
    {
      level: responseStatus && responseStatus < 500 ? 'warn' : 'error',
      status: 'failed',
      attrs: {
        method: meta.method,
        url: meta.url,
        status: responseStatus ?? null,
        durationMs,
        requestId: meta.requestId,
        errorCode: error.code ?? null,
        errorMessage: error.message,
      },
    },
  );
}

export function installAxiosTraceInstrumentation(): void {
  if (axiosInstalled) {
    return;
  }
  axiosInstalled = true;

  axios.interceptors.request.use((config) => {
    const url = normalizeUrl(config);
    if (!shouldTraceUrl(url)) {
      return config;
    }

    const headers = AxiosHeaders.from(config.headers);
    const traceId = headerValue(headers, AHA_TRACE_HEADERS.traceId) ?? getTraceContext();
    const requestId = headerValue(headers, AHA_TRACE_HEADERS.requestId) ?? generateTraceId();
    const spanId = headerValue(headers, AHA_TRACE_HEADERS.spanId) ?? generateTraceId();

    headers.set(AHA_TRACE_HEADERS.traceId, traceId);
    headers.set(AHA_TRACE_HEADERS.requestId, requestId);
    headers.set(AHA_TRACE_HEADERS.spanId, spanId);
    config.headers = headers;

    (config as TraceAxiosConfig).ahaTraceMeta = {
      traceId,
      requestId,
      startedAt: Date.now(),
      url,
      method: normalizeMethod(config),
    };

    return config;
  });

  axios.interceptors.response.use(
    (response) => {
      emitHttpTrace(response, response.status >= 400);
      return response;
    },
    (error) => {
      if (axios.isAxiosError(error)) {
        emitHttpErrorTrace(error);
      }
      return Promise.reject(error);
    },
  );
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function mergeFetchHeaders(headers?: HeadersInit): Headers {
  const merged = new Headers(headers);
  const traceId = merged.get(AHA_TRACE_HEADERS.traceId) ?? getTraceContext();
  const requestId = merged.get(AHA_TRACE_HEADERS.requestId) ?? generateTraceId();
  const spanId = merged.get(AHA_TRACE_HEADERS.spanId) ?? generateTraceId();

  merged.set(AHA_TRACE_HEADERS.traceId, traceId);
  merged.set(AHA_TRACE_HEADERS.requestId, requestId);
  merged.set(AHA_TRACE_HEADERS.spanId, spanId);
  return merged;
}

export function installFetchTraceInstrumentation(): void {
  if (fetchInstalled || typeof globalThis.fetch !== 'function') {
    return;
  }
  fetchInstalled = true;

  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = fetchInputUrl(input);
    if (!shouldTraceUrl(url)) {
      return originalFetch(input, init);
    }

    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
    const headers = mergeFetchHeaders(init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined));
    const traceId = headers.get(AHA_TRACE_HEADERS.traceId) ?? getTraceContext();
    const requestId = headers.get(AHA_TRACE_HEADERS.requestId) ?? generateTraceId();
    const startedAt = Date.now();

    try {
      const response = await originalFetch(input, { ...init, headers });
      const failed = response.status >= 400;
      emitTraceEvent(
        failed ? TraceEventKind.http_request_failed : TraceEventKind.http_request_completed,
        'fetch-client',
        { trace_id: traceId },
        `${method} ${url.split('?')[0]} -> ${response.status}`,
        {
          level: failed ? 'warn' : 'debug',
          status: failed ? 'failed' : 'ok',
          attrs: {
            method,
            url: url.split('?')[0],
            status: response.status,
            durationMs: Date.now() - startedAt,
            requestId,
          },
        },
      );
      return response;
    } catch (error) {
      emitTraceEvent(
        TraceEventKind.http_request_failed,
        'fetch-client',
        { trace_id: traceId },
        `${method} ${url.split('?')[0]} -> ${error instanceof Error ? error.message : 'fetch failed'}`,
        {
          level: 'error',
          status: 'failed',
          attrs: {
            method,
            url: url.split('?')[0],
            durationMs: Date.now() - startedAt,
            requestId,
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        },
      );
      throw error;
    }
  };
}
