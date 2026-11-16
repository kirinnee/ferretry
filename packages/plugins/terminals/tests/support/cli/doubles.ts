import type { PluginClient, TerminalIo, VerbInvocation } from '@ferretry/kernel/manifest';

export interface RecordedCall {
  readonly route: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/** A plugin client that records every route call and answers from `reply`. It never reaches a daemon. */
export function recordingClient(reply: (call: RecordedCall) => unknown) {
  const calls: RecordedCall[] = [];
  const client: PluginClient = {
    call: async <Answer>(route: string, init?: Parameters<PluginClient['call']>[1]): Promise<Answer> => {
      const call: RecordedCall = {
        route,
        ...(init?.params === undefined ? {} : { params: init.params }),
        ...(init?.body === undefined ? {} : { body: init.body }),
      };
      calls.push(call);
      return (await reply(call)) as Answer;
    },
    subscribe: () => () => undefined,
  };
  return { calls, client };
}

/** A terminal that keeps what was printed. */
export function capturedIo(): TerminalIo & { readonly printed: string[]; readonly errors: string[] } {
  const printed: string[] = [];
  const errors: string[] = [];
  return {
    printed,
    errors,
    isTty: false,
    out: text => printed.push(text),
    err: text => errors.push(text),
  };
}

/** A verb invocation as the shell's parser hands it over. */
export const invocation = (args: readonly string[], options: VerbInvocation['options'] = {}): VerbInvocation => ({
  args,
  options,
});
