/**
 * The safety audit behind "the shell refuses an option a verb does not declare" (`option-guard.ts`), over the REAL
 * generated registry: every verb the shell can run.
 *
 * - **Reads**: each verb's handler runs against a recording `options` (nothing typed, every name a text, every name
 *   on), once with no words and once with three, and every name the code asks for must be declared by its manifest
 *   (listed, or `hidden`). A name the code reads and the manifest lacks is a flag the shell would refuse that worked
 *   before: the fix is the declaration, never the behaviour.
 * - **Opt-outs**: a verb in `SELF_VALIDATING` reads its options by walking every one typed (or the raw words), so its
 *   names are not visible here. Each is proven to refuse an unknown flag itself, naming it, with nothing sent.
 * - **Shell verbs**: the shell's own handlers read through a few helpers; every literal name they read is declared by
 *   some shell verb line.
 */
import { describe, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import should from 'should';
import { registry } from '../../src/generated/commands.ts';
import { flagNames } from '../../src/lib/argv.ts';
import { declaredOptionNames, isSelfValidating, SHELL_WIDE_OPTIONS } from '../../src/lib/option-guard.ts';
import type { CommandRegistry } from '../../src/lib/registry.ts';
import { runFy } from '../../src/lib/run.ts';
import { buildVerbTable } from '../../src/lib/verbs.ts';
import { fakeWorld, RecordingTransport } from './fakes.ts';

/**
 * What a probe's `options` answers: nothing typed; every name a text; every name on; or only the verb's own listed
 * options, each as it is declared (a switch on, a value a text) — so a handler that stops early on a bare run (`new`
 * wants a `--runtime`) goes on to read the rest.
 */
type Mode = 'nothing' | 'text' | 'on' | 'declared' | 'valued';
const MODES: readonly Mode[] = ['nothing', 'text', 'on', 'declared', 'valued'];
/**
 * What a valued option answers in the `valued` probe when a bare `'x'` would stop the handler before it reads the rest:
 * a value it checks at once (`--mode` is auto or interactive), or a file it would read (the fake host reads none), left
 * unanswered (`null`).
 */
const PLAUSIBLE: Readonly<Record<string, string | null>> = { mode: 'auto', 'prompt-file': null, file: null, f: null };
/** The words after the verb in a probe: none (a group typed bare), then three (a verb with arguments). */
/**
 * Names a handler asks for and then ignores, by verb line: `rules resume` and `rules renew` share one reader of the
 * stage options, and the controller keeps the old rule's username and scope (and, for a resume, its uses and end), so
 * none of these ever changed anything. The shell refusing them removes no behaviour.
 */
const READ_AND_IGNORED: Readonly<Record<string, readonly string[]>> = {
  'rules resume': ['username', 'scope', 'expires', 'uses'],
  'rules renew': ['username', 'scope'],
};
const WORDS: readonly (readonly string[])[] = [[], ['a1', 'a2', 'a3']];
/** A handler that waits on something the fake world never answers is let go after this long. */
const PATIENCE_MS = 400;

const WALKS = '<walks every option>';
const READS_RAW = '<reads the raw words>';

const table = buildVerbTable(registry);
const pluginVerbs = table.entries.filter(entry => entry.owner !== 'shell' && entry.alias === undefined);
const shellVerbs = table.entries.filter(entry => entry.owner === 'shell' && entry.alias === undefined);

/** The probe is slow (every verb, five times, twice) and its answer never changes: it runs once for the file. */
let recorded: Promise<ReadonlyMap<string, ReadonlySet<string>>> | undefined;
const recordReads = (): Promise<ReadonlyMap<string, ReadonlySet<string>>> => {
  recorded ??= probeReads();
  return recorded;
};

/** The probe itself: every name each plugin verb's handler asked its `options` for, by verb line. */
async function probeReads(): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const reads = new Map<string, Set<string>>();
  const current = { line: '', mode: 'nothing' as Mode, shape: new Map<string, true | 'x'>() };
  const answer = (name: string, mode: Mode): unknown => {
    if (mode === 'nothing') return undefined;
    if (mode === 'declared') return current.shape.get(name);
    // The valued options alone: a switch typed beside them (`--auto` beside a named runtime) is itself a refusal.
    if (mode === 'valued')
      return current.shape.get(name) === 'x'
        ? PLAUSIBLE[name] === undefined
          ? 'x'
          : (PLAUSIBLE[name] ?? undefined)
        : undefined;
    return mode === 'text' ? 'x' : true;
  };
  const recording = (set: Set<string>, mode: Mode): Record<string, unknown> =>
    new Proxy(
      {},
      {
        get: (_target, key) => {
          if (typeof key === 'string') set.add(key);
          return typeof key === 'string' ? answer(key, mode) : undefined;
        },
        has: (_target, key) => {
          if (typeof key === 'string') set.add(key);
          return typeof key === 'string' && answer(key, mode) !== undefined;
        },
        ownKeys: () => {
          set.add(WALKS);
          return [];
        },
        getOwnPropertyDescriptor: () => undefined,
      },
    );
  const wrapped: CommandRegistry = {
    ...registry,
    plugins: registry.plugins.map(plugin => ({
      ...plugin,
      load: async () => {
        const half = await plugin.load();
        if (half.skeleton === true || half.build === undefined) return half;
        const { build } = half;
        return {
          ...half,
          build: (context: Parameters<typeof build>[0]) => {
            const built = build(context);
            const verbs: Record<string, (invocation: object) => Promise<number>> = {};
            for (const [line, handler] of Object.entries(
              built.verbs as Record<string, (invocation: object) => Promise<number>>,
            )) {
              verbs[line] = async invocation => {
                const set = reads.get(current.line) ?? new Set<string>();
                reads.set(current.line, set);
                const probe = {
                  ...invocation,
                  options: recording(set, current.mode),
                  get raw() {
                    set.add(READS_RAW);
                    return (invocation as { raw?: unknown }).raw;
                  },
                };
                return await Promise.race([
                  handler(probe),
                  new Promise<number>(resolve => setTimeout(() => resolve(0), PATIENCE_MS)),
                ]);
              };
            }
            return { ...built, verbs };
          },
        };
      },
    })),
  };
  for (const entry of pluginVerbs)
    for (const mode of MODES)
      for (const words of WORDS) {
        current.line = entry.line;
        current.mode = mode;
        current.shape = new Map(
          (entry.options ?? [])
            .filter(option => option.hidden !== true)
            .flatMap(option =>
              flagNames(option.flag).map(name => [name, /[<[]/u.test(option.flag) ? 'x' : true] as const),
            ),
        );
        const { world } = fakeWorld({ registry: wrapped });
        await runFy([...entry.words, ...words], world).catch(() => 0);
      }
  return reads;
}

/** A verb-by-verb probe of the whole registry is seconds, not milliseconds: far over bun's 5 s default on a CI runner. */
const AUDIT_TIMEOUT_MS = 120_000;

const camelToKebab = (name: string): string => name.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`);

describe('verb options audit (the real generated registry)', () => {
  it(
    'should declare every option a plugin verb reads',
    async () => {
      // Arrange
      const reads = await recordReads();
      const undeclared: string[] = [];

      // Act
      for (const entry of pluginVerbs) {
        if (isSelfValidating(entry.owner, entry.line)) continue;
        const known = declaredOptionNames(entry.options);
        const ignored = READ_AND_IGNORED[entry.line] ?? [];
        const missing = [...(reads.get(entry.line) ?? [])].filter(
          name => !known.has(name) && !known.has(camelToKebab(name)) && !ignored.includes(name),
        );
        if (missing.length > 0) undeclared.push(`${entry.owner}: ${entry.line} reads ${missing.join(', ')}`);
      }

      // Assert
      should(undeclared).deepEqual([]);
    },
    AUDIT_TIMEOUT_MS,
  );

  it(
    'should leave only the opted-out verbs walking their options or reading the raw words',
    async () => {
      // Arrange
      const reads = await recordReads();

      // Act
      const walking = pluginVerbs
        .filter(entry => !isSelfValidating(entry.owner, entry.line))
        .filter(entry => reads.get(entry.line)?.has(WALKS) === true || reads.get(entry.line)?.has(READS_RAW) === true)
        .map(entry => `${entry.owner}: ${entry.line}`);

      // Assert
      should(walking).deepEqual([]);
    },
    AUDIT_TIMEOUT_MS,
  );

  it(
    'should have every opted-out verb refuse an unknown option itself, naming it, with nothing sent',
    async () => {
      // Arrange
      const failures: string[] = [];

      // Act
      for (const entry of pluginVerbs.filter(each => isSelfValidating(each.owner, each.line))) {
        const transport = new RecordingTransport();
        const { world, io } = fakeWorld({ registry, transport });
        const code = await runFy([...entry.words, '--zz-unknown'], world).catch(() => -1);
        if (code === 0 || !io.stderr().includes('zz-unknown') || transport.sent.length > 0)
          failures.push(`${entry.owner}: ${entry.line} → exit ${String(code)}, sent ${String(transport.sent.length)}`);
      }

      // Assert
      should(failures).deepEqual([]);
    },
    AUDIT_TIMEOUT_MS,
  );

  it(
    'should declare every literal option name the shell’s own verbs read',
    () => {
      // Arrange
      const folder = new URL('../../src/lib/', import.meta.url).pathname;
      const sources = ['commands', 'machine'].flatMap(directory =>
        readdirSync(join(folder, directory)).map(file => readFileSync(join(folder, directory, file), 'utf8')),
      );
      const read =
        /\b(?:optionOn|optionText|optionList|on|text|flag)\(\s*(?:ctx\.)?(?:invocation|ctx),\s*'([a-z][a-z-]*)'/gu;
      const direct =
        /(?<![/\w.])(?:flags|invocation\.options)\[\s*'([a-z][a-z-]*)'\s*\]|(?<![/\w.])(?:flags|invocation\.options)\.([a-z]\w*)(?!\.ts)/gu;
      const names = new Set<string>();
      for (const source of sources) {
        for (const match of source.matchAll(read)) names.add(match[1] as string);
        for (const match of source.matchAll(direct)) names.add((match[1] ?? match[2]) as string);
      }
      const declared = new Set<string>(SHELL_WIDE_OPTIONS);
      for (const entry of shellVerbs) for (const name of declaredOptionNames(entry.options)) declared.add(name);

      // Act
      const undeclared = [...names].filter(name => !declared.has(name)).sort();

      // Assert
      should(undeclared).deepEqual([]);
    },
    AUDIT_TIMEOUT_MS,
  );
});
