import type { Context } from 'hono';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function requestId(c: Context): string {
  return c.get('requestId') as string;
}

export function errorResponse(c: Context, error: unknown): Response {
  const id = requestId(c);
  if (error instanceof AppError) {
    return c.json({ error: { code: error.code, message: error.message, requestId: id, details: error.details } }, error.status as never);
  }
  console.error(JSON.stringify({ requestId: id, error: error instanceof Error ? error.message : String(error) }));
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', requestId: id } }, 500);
}
