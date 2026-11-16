/**
 * What a failed `fy` run in the two-release fixture says about itself.
 *
 * A bare `expect(run.code).toBe(0)` fails with "Expected 0, Received 1" and nothing else, so the reason `fy` exited
 * (its stderr) is invisible in CI. `expectFyExit` throws instead, naming the argv and carrying the last bytes of both
 * streams. The fixture's daemon mints a real admin token into its temp home, and `fy` is handed it as `FY_TOKEN`, so
 * every secret the fixture holds is masked BEFORE the tail is cut (a cut can not leave half of one behind).
 */

/** The last bytes of each stream that are kept: enough to read an error, bounded so a chatty run stays readable. */
export const TAIL_BYTES = 4096;

export const MASK = '[redacted]';

export interface FyRun {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** `text` with every secret and every `Bearer <value>` replaced by a mask. */
export function masked(text: string, secrets: readonly string[]): string {
  let result = text.replace(/\b(Bearer\s+)\S+/gi, `$1${MASK}`);
  for (const secret of secrets) if (secret !== '') result = result.split(secret).join(MASK);
  return result;
}

/** The last `TAIL_BYTES` of `text` (by UTF-8 bytes), said so when something was cut. */
export function tail(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= TAIL_BYTES) return text;
  return `…[${bytes.length - TAIL_BYTES} earlier bytes cut]\n${bytes.subarray(bytes.length - TAIL_BYTES).toString('utf8')}`;
}

/** The failure text for one run: argv, exit code, then masked and bounded stderr and stdout. */
export function describeFyRun(
  argv: readonly string[],
  run: FyRun,
  secrets: readonly string[],
  expected: number,
): string {
  const stream = (name: string, text: string): string =>
    `--- ${name} ---\n${tail(masked(text, secrets)).trimEnd() || '(empty)'}`;
  return [
    `\`fy ${argv.join(' ')}\` exited ${run.code}, expected ${expected}`,
    stream('stderr', run.err),
    stream('stdout', run.out),
  ].join('\n');
}

/** Returns `run` when it exited with `expected`; throws with `describeFyRun` otherwise. */
export function expectFyExit(argv: readonly string[], run: FyRun, expected: number, secrets: readonly string[]): FyRun {
  if (run.code !== expected) throw new Error(describeFyRun(argv, run, secrets, expected));
  return run;
}
