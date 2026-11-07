import cli from '../../../cli/index.ts';
import manifest from '../../../manifest.ts';

export interface Call {
  readonly route: string;
  readonly init?: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown } | undefined;
}

type Answer = unknown | ((call: Call) => unknown);

export interface RunResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly calls: readonly Call[];
}

export interface RunOptions {
  readonly args?: readonly string[];
  readonly options?: Readonly<Record<string, string | boolean | readonly string[]>>;
  /** Route key to the answer it gets; a function sees the call. A route with no answer fails loudly. */
  readonly answers?: Readonly<Record<string, Answer>>;
  /** `FY_SESSION_ID` and the shell's other names, as the shell's context will hold them. */
  readonly env?: Readonly<Record<string, string>>;
  /** Files (and `-` for standard input) the shell can read. */
  readonly files?: Readonly<Record<string, string>>;
}

/** Builds the half the way the shell does, with a recording client and terminal, and runs one verb of it. */
export async function run(verb: string, given: RunOptions = {}): Promise<RunResult> {
  const calls: Call[] = [];
  let out = '';
  let err = '';
  const files = given.files ?? {};
  const context = {
    manifest,
    client: {
      call: async (route: string, init?: Call['init']) => {
        const call = { route, init };
        calls.push(call);
        const answer = given.answers?.[route];
        if (answer === undefined) throw new Error(`no answer for ${route}`);
        return typeof answer === 'function' ? (answer as (call: Call) => unknown)(call) : answer;
      },
      subscribe: () => () => {},
    },
    io: { out: (text: string) => (out += text), err: (text: string) => (err += text), isTty: false },
    env: given.env ?? {},
    readText: async (path: string) => {
      const text = files[path];
      if (text === undefined) throw new Error(`no such file ${path}`);
      return text;
    },
  };
  const half = cli.build?.(context as never);
  const handler = (half?.verbs as Record<string, (invocation: unknown) => Promise<number>>)[verb];
  if (handler === undefined) throw new Error(`the half does not implement "${verb}"`);
  const code = await handler({ args: given.args ?? [], options: given.options ?? {} });
  return { code, out, err, calls };
}

export { cli, manifest };
