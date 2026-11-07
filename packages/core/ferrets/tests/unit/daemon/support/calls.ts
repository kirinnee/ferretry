import type { CallContext } from '@ferretry/kernel/contract';
import { type FerretSummary } from '../../../../contract/index.ts';
import { ferretId, T0 } from '../../../../contract/testing/index.ts';

/** A call as a handler sees it: the path parameters and a request whose body is `body`. Gate's standing is not here. */
export function callOf(params: Readonly<Record<string, string>>, body?: unknown): CallContext {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return {
    params: new Map(Object.entries(params)),
    request: {
      method: 'POST',
      path: '/',
      headers: new Headers(),
      query: new URLSearchParams(),
      text: async () => text,
    },
  } as unknown as CallContext;
}

/** One ferret as the registry answers it. */
export function ferretSummary(id: string, overrides: Partial<FerretSummary> = {}): FerretSummary {
  return {
    id: ferretId(id),
    name: id,
    role: 'lead',
    harness: 'claude-code',
    runner: 'tmux',
    folder: `/work/${id}`,
    state: 'working',
    createdAt: T0,
    stateAt: T0,
    ...overrides,
  };
}

/** The body of a JSON response. */
export const bodyOf = (response: { readonly body: unknown }): Record<string, unknown> =>
  (typeof response.body === 'string' ? JSON.parse(response.body) : response.body) as Record<string, unknown>;

/** The ApiError a handler threw, as `{ status, code }`, or the value it answered. */
export async function refusalOf(work: Promise<unknown>): Promise<{ status?: number; code?: string } | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return { status: (error as { status?: number }).status, code: (error as { code?: string }).code };
  }
}
