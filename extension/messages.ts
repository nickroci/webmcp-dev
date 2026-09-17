export class WorkerUnavailableError extends Error {
  constructor() {
    super('The extension background worker did not reply. Reload the extension, then reopen this popup.');
    this.name = 'WorkerUnavailableError';
  }
}

/** An updated popup can load from disk while an older worker is still running. */
export async function sendWorkerMessage(message: unknown): Promise<Record<string, any>> {
  let response: unknown;
  try { response = await chrome.runtime.sendMessage(message); }
  catch { throw new WorkerUnavailableError(); }
  if (!response || typeof response !== 'object' || !('ok' in response) || typeof response.ok !== 'boolean') throw new WorkerUnavailableError();
  return response as Record<string, any>;
}
