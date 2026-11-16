/**
 * The shell's one passkey prompt, as a test sees it. `usePasskeyAsk` (`@ferretry/app`) needs a whole mounted shell, so a
 * suite installs a recording stand-in for just that hook with {@link installShellAsk}; everything else of
 * `@ferretry/app` stays real (`daemonOfClient` included), so a client is tagged with its machine exactly as the shell
 * tags the clients it makes. The shell's own half of this seam is proved in `packages/app/tests/unit/shell`.
 *
 * `mock.module` replaces a module for the whole bun process, so the real exports are copied before anything is
 * mocked and put back when the calling suite is done.
 */

import { afterAll, afterEach, mock } from 'bun:test';
import * as realApp from '@ferretry/app';
import { noteClientDaemon } from '@ferretry/app/testing';

export type ShellAskRequest = Parameters<NonNullable<ReturnType<typeof realApp.usePasskeyAsk>>>[1];

/** What the next `usePasskeyAsk()` hands out; `undefined` is a shell with no passkey mount. */
type Mode = { readonly kind: 'none' } | { readonly kind: 'answer'; readonly answer: 'yes' | 'no' | 'throw' };

let mode: Mode = { kind: 'none' };
const asked: { readonly daemon: string; readonly request: ShellAskRequest }[] = [];

const ask = async (daemon: string, request: ShellAskRequest): Promise<boolean> => {
  asked.push({ daemon, request });
  if (mode.kind === 'answer' && mode.answer === 'throw') throw new Error('the prompt broke');
  return mode.kind === 'answer' && mode.answer === 'yes';
};

const real: object = { ...realApp };

/** Installs the stand-in for the calling suite and puts the real `@ferretry/app` back afterwards. */
export function installShellAsk(): void {
  mock.module('@ferretry/app', () => ({ ...real, usePasskeyAsk: () => (mode.kind === 'none' ? undefined : ask) }));
  afterEach(() => {
    mode = { kind: 'none' };
    asked.length = 0;
  });
  afterAll(() => {
    mock.module('@ferretry/app', () => real);
  });
}

/** The machine every test client is built for. */
export const DAEMON = 'fy_daemon_one';

/** Who answers the prompt: yes (confirmed), no (dismissed), a throw, or nobody (no passkey mount in the shell). */
export const promptAnswers = (answer: 'yes' | 'no' | 'throw' | 'none'): void => {
  mode = answer === 'none' ? { kind: 'none' } : { kind: 'answer', answer };
};

/** Every ask the shell's prompt was given, in order. */
export const shellAsks = (): readonly { readonly daemon: string; readonly request: ShellAskRequest }[] => asked;

/** Tags a test client with its machine, as the shell does for every client it hands a half. */
export const onMachine = <T extends object>(client: T, daemon: string = DAEMON): T => {
  noteClientDaemon(client, daemon);
  return client;
};
