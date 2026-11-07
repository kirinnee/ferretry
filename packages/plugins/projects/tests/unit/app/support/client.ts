/**
 * A scripted per-daemon client for the Projects app suites: `route key` -> answer. A route with no answer fails like an
 * unreachable daemon; an `Error` answer is thrown; a function answer is called with the call and may be async. Every
 * call is recorded, so a suite asserts what the page actually sent.
 *
 * A fresh client per test matters: the registry store is keyed by client (`projectsStoreFor`), so one test's rows can
 * never answer another's.
 */

import { type ProjectInfo, ProjectInfoSchema } from '../../../../contract/index.ts';
import type { ProjectsClient } from '../../../../app/lib/client.ts';
import type { FerretRow } from '../../../../app/lib/ferrets.ts';

export interface Call {
  readonly route: string;
  readonly params: Readonly<Record<string, string>> | undefined;
  readonly query: Readonly<Record<string, string>> | undefined;
  readonly body: unknown;
}

export type Route = unknown | Error | ((call: Call) => unknown);

export const scripted = (routes: Readonly<Record<string, Route>>, calls: Call[] = []): ProjectsClient => ({
  call: async <Answer = unknown>(
    route: string,
    init?: {
      readonly params?: Readonly<Record<string, string>>;
      readonly query?: Readonly<Record<string, string>>;
      readonly body?: unknown;
    },
  ): Promise<Answer> => {
    const call: Call = { route, params: init?.params, query: init?.query, body: init?.body };
    calls.push(call);
    if (!(route in routes)) throw new Error(`no route ${route}`);
    const answer = routes[route];
    const value = typeof answer === 'function' ? await (answer as (call: Call) => unknown)(call) : answer;
    if (value instanceof Error) throw value;
    return value as Answer;
  },
});

/** A refusal shaped like the shell's `DaemonCallError`: a status, a code and the daemon's sentence. */
export const refusal = (status: number, message: string, code?: string): Error =>
  Object.assign(new Error(message), { status, ...(code === undefined ? {} : { code }) });

export const PROJECT: ProjectInfo = ProjectInfoSchema.parse({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'ferretry',
  path: '/work/ferretry',
  source: 'existing-folder',
  createdAt: '2026-08-01T10:00:00.000Z',
});

export const ANSWERED: ProjectInfo = ProjectInfoSchema.parse({
  id: '22222222-2222-4222-8222-222222222222',
  name: 'scratch',
  path: '/home/k/scratch',
  source: 'confirmed-discovery',
  createdAt: '2026-08-06T11:00:00.000Z',
});

export const ferret = (
  id: string,
  folder: string,
  overrides: Partial<Omit<FerretRow, 'id' | 'folder'>> = {},
): FerretRow => ({
  id,
  name: id,
  harness: 'claude-code',
  folder,
  state: 'working',
  stateAt: '2026-08-06T10:00:00.000Z',
  ...overrides,
});

/** Board's switch as its route answers it, for the project page's Board section. */
export const SWITCH_OFF = { projectId: PROJECT.id, on: false, setBy: 'default', setAt: null };

/** Clicks an element the way a reader does. */
export const clickEvent = (): MouseEvent => new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });

/** Sets a controlled input's value the way typing does, so React's onChange fires. */
export const typeInto = (input: HTMLInputElement, value: string): void => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
