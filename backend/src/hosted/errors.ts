export type ModelFailureReason = 'timeout' | 'cancelled' | 'network' | 'authentication' | 'access' | 'quota' | 'rate-limit' | 'model-not-found' | 'bad-request' | 'provider-server' | 'http-error' | 'incomplete-output' | 'refusal' | 'prompt-rejected' | 'invalid-output' | 'response-too-large' | 'empty-response' | 'provider-failed';
export type ModelParseStage = 'response-json' | 'response-envelope' | 'response-status' | 'message-content' | 'decision-json' | 'decision-schema' | 'decision-consistency' | 'usage';
export interface ModelFailure { reason: ModelFailureReason; httpStatus?: number; apiCode?: string; retryAfterMs?: number;
  requestId?: string; parameter?: string; requestIssue?: 'schema' | 'reasoning' | 'context' | 'parameter' | 'policy' | 'other';
  stage?: ModelParseStage; issues?: {field:string;code:string}[]; outputTextParts?: number;
  requestConstraint?: 'unsupported-effort' | 'missing-effort' | 'reasoning-token-budget' | 'incompatible-reasoning';
  incompleteReason?: 'max_output_tokens' | 'content_filter' | 'other';
  jsonShape?: 'fenced' | 'object-truncated' | 'object-with-extra-text' | 'non-json' | 'malformed-json';
  textChars?: number; requestedEffort?: string; returnedEffort?: string;
  inputTokens?: number; outputTokens?: number; reasoningTokens?: number;
}
export function safeRequestId(value: string | null): string | undefined {
  return value && /^req_[a-zA-Z0-9_-]{1,120}$/.test(value) ? value : undefined;
}
export function requestFailureDetails(error: unknown): Pick<ModelFailure, 'parameter' | 'requestIssue' | 'requestConstraint'> {
  const body = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const known = ['model', 'input', 'instructions', 'max_output_tokens', 'reasoning', 'reasoning.effort', 'text.format', 'text.format.schema', 'text.format.schema.properties.target', 'text.format.schema.properties.memory'];
  const parameter = typeof body.param === 'string' && known.includes(body.param) ? body.param : undefined;
  const message = typeof body.message === 'string' ? body.message.toLowerCase().replace(/https?:\/\/\S+/g, '') : '';
  // Match categories in memory, then discard the raw provider message.
  const requestIssue = /(?:flagged|violat|reject).{0,100}(?:usage policy|content policy|safety)|(?:usage policy|content policy|safety).{0,100}(?:flagged|violat|reject)/.test(message) ? 'policy' : /schema/.test(message) ? 'schema' : /reasoning/.test(message) ? 'reasoning' : /context.{0,30}(length|window)|maximum context/.test(message) ? 'context' : /unsupported parameter|not supported|unsupported value/.test(message) ? 'parameter' : 'other';
  const requestConstraint: ModelFailure['requestConstraint'] = requestIssue !== 'reasoning' ? undefined
    : /reasoning.{0,100}(budget|minimum|at least|too small)|(?:budget|minimum|at least|too small).{0,100}reasoning/.test(message) ? 'reasoning-token-budget'
    : /(?:not supported|unsupported).{0,100}(?:effort|none)|(?:effort|none).{0,100}(?:not supported|unsupported)/.test(message) ? 'unsupported-effort'
    : /(?:reasoning|effort).{0,80}(?:required|missing)|(?:required|missing).{0,80}(?:reasoning|effort)/.test(message) ? 'missing-effort'
    : /(?:incompatible|cannot|must not).{0,100}reasoning|reasoning.{0,100}(?:incompatible|cannot|must not)/.test(message) ? 'incompatible-reasoning' : undefined;
  return { ...(parameter ? {parameter} : {}), requestIssue, ...(requestConstraint ? {requestConstraint} : {}) };
}
export class ModelProviderError extends Error {
  constructor(readonly diagnostic: ModelFailure) {
    super(`MODEL_${diagnostic.reason.replaceAll('-', '_').toUpperCase()}`);
    this.name = 'ModelProviderError';
  }
}
const apiCodes = new Set(['insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'usage_limit_exceeded', 'rate_limit_exceeded', 'slow_down', 'server_is_overloaded', 'invalid_api_key', 'model_not_found', 'context_length_exceeded', 'unsupported_value', 'invalid_request_error']);
export function httpModelFailure(status: number, code: unknown, retryAfter: string | null): ModelFailure {
  const apiCode = typeof code === 'string' && apiCodes.has(code) ? code : undefined;
  const quota = apiCode && ['insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'usage_limit_exceeded'].includes(apiCode);
  const reason: ModelFailureReason = quota ? 'quota' : status === 401 ? 'authentication' : status === 403 ? 'access' : status === 404 ? 'model-not-found' : status === 408 ? 'timeout' : status === 429 ? 'rate-limit' : status >= 500 ? 'provider-server' : status >= 400 ? 'bad-request' : 'http-error';
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  return { reason, httpStatus: status, ...(apiCode ? { apiCode } : {}), ...(Number.isFinite(seconds) && seconds >= 0 && seconds <= 86400 ? { retryAfterMs: seconds * 1000 } : {}) };
}
export function modelFailure(error: unknown, signal?: AbortSignal): ModelFailure {
  if (signal?.aborted) return { reason: signal.reason === 'shutdown' ? 'cancelled' : 'timeout' };
  if (error instanceof ModelProviderError) return error.diagnostic;
  if (error instanceof Error) {
    const known: Record<string, ModelFailureReason> = { MODEL_INCOMPLETE: 'incomplete-output', MODEL_REFUSED: 'refusal', MODEL_RESPONSE_TOO_LARGE: 'response-too-large', MODEL_EMPTY_RESPONSE: 'empty-response', MODEL_INVALID_OUTPUT: 'invalid-output', MODEL_INVALID_DIRECTION: 'invalid-output', MODEL_OUTPUT_LIMIT: 'invalid-output' };
    const reason = known[error.message];
    if (reason) return { reason };
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return { reason: 'timeout' };
    if (error instanceof SyntaxError || error.name === 'ZodError') return { reason: 'invalid-output' };
    const code = (error.cause as { code?: string } | undefined)?.code;
    if (code && ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) return { reason: 'timeout' };
    if (code && ['ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_SOCKET'].includes(code)) return { reason: 'network' };
    if (error instanceof TypeError && error.message === 'fetch failed') return { reason: 'network' };
  }
  return { reason: 'provider-failed' };
}
