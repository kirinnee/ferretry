/** A scripted client: an answer per route key (a function, an Error to throw, or a value); every call is recorded. */
export interface Call {
  readonly route: string;
  readonly init?: { readonly body?: unknown; readonly query?: unknown; readonly quiet?: boolean };
}

export const scripted = (table: Record<string, unknown>, calls: Call[] = []) => ({
  calls,
  call: async <Answer = unknown>(route: string, init?: Call['init']): Promise<Answer> => {
    calls.push({ route, ...(init === undefined ? {} : { init }) });
    if (!(route in table)) throw new Error(`no route ${route}`);
    const answer = table[route];
    const value = typeof answer === 'function' ? (answer as (init?: Call['init']) => unknown)(init) : answer;
    if (value instanceof Error) throw value;
    return value as Answer;
  },
  subscribe: () => () => undefined,
});
