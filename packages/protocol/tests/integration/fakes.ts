import type { IFyEventTransport, IFyHttpTransport } from '../../src/lib/client.ts';

export interface RecordedHttpCall {
  readonly url: string;
  readonly init: RequestInit;
}

type HttpOutcome = Response | { readonly throws: unknown } | ((call: RecordedHttpCall) => Response | Promise<Response>);

export class QueuedHttpTransport implements IFyHttpTransport {
  readonly calls: RecordedHttpCall[] = [];
  readonly #outcomes: HttpOutcome[] = [];

  constructor(...outcomes: HttpOutcome[]) {
    this.#outcomes.push(...outcomes);
  }

  enqueue(...outcomes: HttpOutcome[]): void {
    this.#outcomes.push(...outcomes);
  }

  async send(url: string, init: RequestInit): Promise<Response> {
    const call = {
      url,
      init: { ...init, headers: new Headers(init.headers) },
    } satisfies RecordedHttpCall;
    this.calls.push(call);
    const outcome = this.#outcomes.shift();
    if (outcome === undefined) throw new Error(`no queued HTTP outcome for ${url}`);
    if (typeof outcome === 'function') return outcome(call);
    if ('throws' in outcome) throw outcome.throws;
    return outcome;
  }
}

export interface RecordedEventCall {
  readonly url: string;
  readonly token: string;
}

export class QueuedEventTransport implements IFyEventTransport {
  readonly calls: RecordedEventCall[] = [];
  readonly #messages: unknown[] = [];

  constructor(...messages: unknown[]) {
    this.#messages.push(...messages);
  }

  enqueue(...messages: unknown[]): void {
    this.#messages.push(...messages);
  }

  async stream(input: { url: string; token: string; onMessage(value: unknown): void }): Promise<void> {
    this.calls.push({ url: input.url, token: input.token });
    for (const message of this.#messages.splice(0)) input.onMessage(message);
  }
}

export const jsonResponse = (value: unknown, init: ResponseInit = {}): Response => {
  const response = new Response(JSON.stringify(value), init);
  if (!response.headers.has('content-type')) response.headers.set('content-type', 'application/json');
  return response;
};

export const textResponse = (value: string, init: ResponseInit = {}): Response => new Response(value, init);

export const emptyResponse = (init: ResponseInit = {}): Response => new Response(null, { ...init, status: 204 });

export const captureError = async (operation: () => unknown | Promise<unknown>): Promise<unknown> => {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error('expected operation to reject');
};
