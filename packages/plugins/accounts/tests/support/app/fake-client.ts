/**
 * A fake Accounts client for the app half's tests: it takes a call by route KEY (`METHOD /path/:param`), records the
 * call with the path filled and the query appended (so a test reads `GET /v1/copy-rules` as today's tests did), hands
 * the body over as the object that was sent, and answers what the test says. The caller parses the answer itself.
 */

export interface Call {
  /** `METHOD` of the route key. */
  readonly method: string;
  /** The route's path with its params filled in and its query appended. */
  readonly path: string;
  /** The route key as the manifest declares it. */
  readonly route: string;
  readonly body: unknown;
}

type Init = {
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
};

const fill = (template: string, params: Readonly<Record<string, string>> = {}): string =>
  template.replace(/:([A-Za-z][A-Za-z0-9_]*)/gu, (_, name: string) => encodeURIComponent(params[name] ?? `:${name}`));

export const fakeClient = (answer: (call: Call) => unknown = () => ({})) => {
  const calls: Call[] = [];
  const client = {
    call: async (route: string, init?: Init) => {
      const [method = 'GET', template = ''] = route.split(' ');
      const query =
        init?.query === undefined || Object.keys(init.query).length === 0
          ? ''
          : `?${new URLSearchParams(init.query).toString()}`;
      const call: Call = { method, path: `${fill(template, init?.params)}${query}`, route, body: init?.body };
      calls.push(call);
      return answer(call);
    },
  };
  return { client: client as never, calls };
};

/**
 * A fake client that answers from a table keyed by `METHOD path` (the path filled in, as {@link fakeClient} records it):
 * a value is the answer, an `Error` is thrown, a function is asked on every call. A call the table has no key for
 * is a test failure, not a quiet empty answer.
 */
export const answeredClient = (answers: Readonly<Record<string, unknown>>) => {
  const fake = fakeClient(call => {
    const key = `${call.method} ${call.path}`;
    if (!(key in answers)) throw new Error(`the fake daemon has no answer for ${key}`);
    const answer = answers[key];
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? (answer as () => unknown)() : answer;
  });
  return fake;
};
