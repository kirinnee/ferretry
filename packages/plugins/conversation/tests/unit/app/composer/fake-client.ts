/**
 * A fake of the half's generated client that records every call by route key and answers from a function. It names no
 * daemon until a test names one with `noteClientDaemon` (`@ferretry/app/testing`), as the shell does for its clients.
 */
import { DaemonCallError } from '@ferretry/app';
import type { ConversationCaller } from '../../../../app/composer/seam.ts';

export interface FakeCall {
  readonly route: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export const fakeClient = (
  answer: (call: FakeCall) => unknown,
): { readonly client: ConversationCaller; readonly calls: FakeCall[] } => {
  const calls: FakeCall[] = [];
  const client: ConversationCaller = {
    call: async <Answer>(
      route: string,
      init: {
        params?: Readonly<Record<string, string>>;
        query?: Readonly<Record<string, string>>;
        body?: unknown;
      } = {},
    ): Promise<Answer> => {
      const call: FakeCall = { route, params: init.params ?? {}, query: init.query ?? {}, body: init.body };
      calls.push(call);
      return (await answer(call)) as Answer;
    },
  };
  return { client, calls };
};

/** The refusal the generated client throws. */
export const refusal = (status: number, code: string, message: string): DaemonCallError =>
  new DaemonCallError(status, code, message);
