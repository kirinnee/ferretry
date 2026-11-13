import { describe, it } from 'bun:test';
import should from 'should';
import { registry } from '../../src/generated/commands.ts';
import { runFy } from '../../src/lib/run.ts';
import { buildVerbTable, resolveVerb, type VerbEntry, type VerbTable } from '../../src/lib/verbs.ts';
import { fakeWorld } from './fakes.ts';

/**
 * An unknown sub-verb exits non-zero EVERYWHERE (lead ruling), whatever stands before it: `fy agenda --json frobnicate`
 * ran the roll-up and exited 0 because the resolver looked only at the words before the first option. This enumerates the
 * REAL registry — every verb that has sub-verbs, not a list written here — so a plugin added tomorrow is covered by this
 * test without anyone remembering to add it.
 */

const table: VerbTable = buildVerbTable(registry);

const subverbsBelow = (words: readonly string[]): readonly VerbEntry[] =>
  table.entries.filter(
    entry => entry.words.length > words.length && words.every((word, at) => entry.words[at] === word),
  );

/** A word run is a parent when something is one word deeper below it; its own line may or may not name arguments. */
const parents: readonly (readonly string[])[] = [
  ...new Map(
    table.entries
      .flatMap(entry =>
        Array.from({ length: entry.words.length }, (_, at) => entry.words.slice(0, at + 1)).filter(
          words => subverbsBelow(words).length > 0,
        ),
      )
      .map(words => [words.join(' '), words] as const),
  ).values(),
];

/** Whether the words are a verb in their own right (`agenda`), not only the front of other verbs (`terminal` of `terminal open`). */
const isVerb = (words: readonly string[]): boolean =>
  table.entries.some(entry => entry.words.join(' ') === words.join(' '));

/** A front word the shell can attribute to a verb: `board lanes` is not a verb, but `board` is, and answers for it. */
const underAVerb = (words: readonly string[]): boolean => words.some((_, at) => isVerb(words.slice(0, at + 1)));

const takesWords = (words: readonly string[]): boolean => {
  const own = table.entries.find(entry => entry.words.join(' ') === words.join(' '));
  return own !== undefined && /[<[]/u.test(own.line);
};

describe('every verb with sub-verbs, from the real registry', () => {
  it('should find the parents this test is about (a registry that lost them would pass it vacuously)', () => {
    const names = parents.map(words => words.join(' '));
    for (const expected of [
      'agenda',
      'board',
      'daemon config',
      'daemon security',
      'worktree',
      'tunnel',
      'lesson',
      'lesson global',
      'machine',
      'update',
    ])
      should(names).containEql(expected);
    should(parents.length).be.above(14);
  });

  for (const words of parents.filter(each => !takesWords(each))) {
    const name = words.join(' ');
    describe(name, () => {
      for (const [label, after] of [
        ['bare', ['frobnicate']],
        ['after a switch', ['--json', 'frobnicate']],
        ['after a switch and --', ['--json', '--', 'frobnicate']],
        ['after two switches', ['--json', '--yes', 'frobnicate']],
      ] as const)
        it(`should refuse an unknown sub-verb ${label}, naming the real ones`, () => {
          const resolved = resolveVerb(table, [...words, ...after]);
          // A front word that is no verb itself (`terminal`) is an unknown verb; either way it is refused.
          should(resolved.kind).equal(underAVerb(words) ? 'subverb' : 'unknown');
          if (resolved.kind !== 'subverb') return;
          should(resolved.parent.words).deepEqual(words);
          should(resolved.word).equal('frobnicate');
          should(resolved.subverbs.length).be.above(0);
        });

      it('should run each real child, with the switch before it kept', () => {
        for (const child of subverbsBelow(words).filter(each => each.words.length === words.length + 1)) {
          const resolved = resolveVerb(table, [...words, '--json', child.words.at(-1) as string, 'x']);
          // A child that is itself a parent resolves to it (or to its own deeper child); either way it is not a refusal of `child`.
          should(resolved.kind === 'subverb' ? resolved.word : undefined).not.equal(child.words.at(-1));
          if (resolved.kind === 'verb' && resolved.entry.words.join(' ') === child.words.join(' '))
            should(resolved.rest).deepEqual(['--json', 'x']);
        }
      });
    });
  }

  for (const words of parents.filter(takesWords)) {
    const name = words.join(' ');
    describe(`${name} (it takes words of its own)`, () => {
      it('should keep a word that is no sub-verb as its own argument', () => {
        const resolved = resolveVerb(table, [...words, 'plainly-an-argument']);
        should(resolved.kind).equal('verb');
      });

      it('should refuse a near misspelling of a sub-verb, and take it as words after --', () => {
        const sub = subverbsBelow(words).find(
          each => each.words.length === words.length + 1 && (each.words.at(-1) as string).length >= 4,
        );
        if (sub === undefined) return;
        const real = sub.words.at(-1) as string;
        const typo = `${real.slice(0, -2)}${real.slice(-1)}${real.slice(-2, -1)}`;
        const refused = resolveVerb(table, [...words, typo]);
        should(refused.kind).equal('subverb');
        should(resolveVerb(table, [...words, '--', typo]).kind).equal('verb');
      });
    });
  }

  it('should exit 2 and name the sub-verbs through the whole shell, for every parent, with no daemon call', async () => {
    for (const words of parents.filter(each => !takesWords(each))) {
      for (const after of [['frobnicate'], ['--json', 'frobnicate'], ['--json', '--', 'frobnicate']]) {
        const { world, io, transport } = world0();
        const code = await runFy([...words, ...after], world);
        should(`${words.join(' ')} ${after.join(' ')}: ${String(code)}`).equal(
          `${words.join(' ')} ${after.join(' ')}: 2`,
        );
        should(io.stderr()).containEql(underAVerb(words) ? '"frobnicate" is not a sub-verb of' : 'unknown verb');
        should(io.stdout()).equal('');
        should(transport.sent).deepEqual([]);
      }
    }
  });
});

function world0() {
  return fakeWorld({
    registry,
    inventory: {
      protocol: 'x' as never,
      plugins: [
        { id: 'kernel', on: true, contract: registry.kernel.contract },
        ...registry.plugins.map(plugin => ({ id: plugin.id, on: true, contract: plugin.contract })),
      ],
    },
  });
}
