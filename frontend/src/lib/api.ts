export const API = (import.meta.env.VITE_API_BASE || '/api').replace(/\/$/, '');
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  token?: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
  idempotency?: string,
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotency ? { 'Idempotency-Key': idempotency } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(
      data.message || 'The request could not be completed.',
      response.status,
      data.error || 'REQUEST_FAILED',
    );
  return data as T;
}
export { amount } from './guards';
export const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.';
