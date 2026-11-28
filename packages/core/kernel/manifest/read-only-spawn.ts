import { DAEMON_PROGRAM, programAmong } from './reach.ts';

/** A whole-program guarantee, or one exact argv shape. null matches ONE non-option argument. */
export type ReadOnlySpawnEntry =
  | string
  | {
      readonly program: string;
      readonly args: readonly (string | null | { readonly prefix: string })[];
      /** Extra path operands are accepted only after a final literal `--`. */
      readonly rest?: 'paths';
      /** These explicit child environment values must accompany the command. */
      readonly env?: Readonly<Record<string, string>>;
    };

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const name = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && !/[\s\0*]/u.test(value) && value !== DAEMON_PROGRAM;
const text = (value: unknown): value is string => typeof value === 'string' && !value.includes('\0');

function valid(entry: unknown): entry is ReadOnlySpawnEntry {
  if (typeof entry === 'string') return name(entry);
  if (!record(entry) || !name(entry.program) || !Array.isArray(entry.args) || entry.args.length === 0) return false;
  if (Object.keys(entry).some(key => !['program', 'args', 'rest', 'env'].includes(key))) return false;
  if (
    !Array.from(entry.args).every(
      arg =>
        arg === null ||
        text(arg) ||
        (record(arg) &&
          Object.keys(arg).length === 1 &&
          typeof arg.prefix === 'string' &&
          /^--[a-z][a-z-]*=$/u.test(arg.prefix)),
    )
  )
    return false;
  if (entry.rest !== undefined && (entry.rest !== 'paths' || entry.args.at(-1) !== '--')) return false;
  return entry.env === undefined || (record(entry.env) && Object.values(entry.env).every(text));
}

/** Unknown/malformed declarations grant nothing; neither a shape nor a whole-program guarantee grants spawn itself. */
export function readOnlySpawnAllows(
  declared: readonly ReadOnlySpawnEntry[] | undefined,
  program: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> | undefined,
): boolean {
  if (!Array.isArray(declared) || !Array.from(declared).every(valid)) return false;
  return declared.some((entry: ReadOnlySpawnEntry) => {
    // Git can write traces or override configuration through otherwise unrelated environment keys.
    const expectedEnv = typeof entry === 'string' ? undefined : entry.env;
    if (
      Object.entries(env ?? {}).some(
        ([key, value]) =>
          key.startsWith('GIT_') &&
          (expectedEnv === undefined || !Object.hasOwn(expectedEnv, key) || expectedEnv[key] !== value),
      )
    )
      return false;
    if (typeof entry === 'string') return programAmong([entry], program);
    if (!programAmong([entry.program], program)) return false;
    if (entry.rest === undefined ? args.length !== entry.args.length : args.length < entry.args.length) return false;
    if (entry.env !== undefined && !Object.entries(entry.env).every(([key, value]) => env?.[key] === value))
      return false;
    return entry.args.every((part, index) => {
      const actual = args[index];
      if (!text(actual)) return false;
      if (part === null) return actual !== '' && !actual.startsWith('-');
      if (typeof part === 'object') return actual.startsWith(part.prefix) && actual.length > part.prefix.length;
      return actual === part;
    });
  });
}
