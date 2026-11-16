/**
 * The CLI half's verbs now come from one file per verb group (`cli/verbs/*.verb.ts`, listed by the generator). This
 * pins that the split changed nothing a caller can see: `fixtures/cli-verbs/base.json` was dumped from the commit before
 * it (the handler key set `implementCli` returned, and the verbs the manifest declares, which is what `fy --help` is
 * drawn from), and both must still match it exactly.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import cli from '../../../cli/index.ts';
import manifest from '../../../manifest.ts';

interface Dump {
  readonly handlers: readonly string[];
  readonly declared: readonly string[];
}

const base = JSON.parse(readFileSync(join(import.meta.dir, '../../fixtures/cli-verbs/base.json'), 'utf8')) as Dump;

const handlers = (): readonly string[] =>
  Object.keys(
    cli.build?.({
      manifest,
      client: { call: async () => ({}) as never, subscribe: () => () => undefined },
      io: { out: () => undefined, err: () => undefined, isTty: false },
    })?.verbs ?? {},
  ).sort();

/** What differs between two lists: names only in the first, names only in the second. */
const differences = (a: readonly string[], b: readonly string[]) => ({
  missing: a.filter(name => !b.includes(name)),
  extra: b.filter(name => !a.includes(name)),
});

describe('the verb files and the base', () => {
  test('handle exactly the verbs the base handled', () => {
    expect(differences(base.handlers, handlers())).toEqual({ missing: [], extra: [] });
  });

  test('leave the declared verb tree (the help) as it was', () => {
    const declared = (manifest.actions as { cli: readonly { verb: string }[] }).cli.map(entry => entry.verb);
    expect(declared).toEqual([...base.declared]);
  });

  test('every declared verb has a handler and every handler a declaration', () => {
    expect(differences(base.declared, handlers())).toEqual({ missing: [], extra: [] });
  });

  test('a dropped verb would be seen', () => {
    const [dropped, ...rest] = handlers();
    expect(differences(base.handlers, rest)).toEqual({ missing: [dropped as string], extra: [] });
  });
});
