export class ToolError extends Error {
  constructor(public code: string, message: string, public details?: unknown) {
    super(message);
    this.name = 'ToolError';
  }
}

export { ToolError as RedditError };

export type ToolResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };
