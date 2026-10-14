import type { Snapshot, Task } from './types.js';
let csrf = '';
export class LocalApiError extends Error { constructor(readonly code: string) { super(code); } }
async function response<T>(reply: Response): Promise<T> {
 const body = await reply.json() as unknown;
 if (!reply.ok) { const error = body as { error?: string }; throw new LocalApiError(error.error ?? 'local_operation_failed'); }
 return body as T;
}
export async function bootstrap(signal?: AbortSignal): Promise<Snapshot> {
 const result = await response<{ csrf: string; data: Snapshot }>(await fetch('/api/bootstrap', { cache: 'no-store', ...(signal ? { signal } : {}) }));
 csrf = result.csrf; return result.data;
}
export async function task(id: string, signal?: AbortSignal): Promise<Task> {
 return response<Task>(await fetch(`/api/tasks/${encodeURIComponent(id)}`, { cache: 'no-store', ...(signal ? { signal } : {}) }));
}
export async function mutate<T>(route: string, body: unknown, version?: string): Promise<T> {
 return response<T>(await fetch(route, { method: 'POST', credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json', 'X-Harness-CSRF': csrf, 'Idempotency-Key': crypto.randomUUID(), ...(version ? { 'If-Match': version } : {}) }, body: JSON.stringify(body) }));
}
