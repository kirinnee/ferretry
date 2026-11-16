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

/**
 * Whether the words sit in (or are) a group that declares a default sub-verb (`account`, `account default`): the shell walks
 * such a group like a verb that has sub-verbs, so an unknown sub-verb is a sub-verb refusal, not an unknown verb.
 */
const hasDefault = (words: readonly string[]): boolean =>
  words.some((_, at) =>
    subverbsBelow(words.slice(0, at + 1)).some(entry => entry.default === true && entry.words.length === at + 2),
  );

const takesWords = (words: readonly string[]): boolean => {
  const own = table.entries.find(entry => entry.words.join(' ') === words.join(' '));
  if (own !== undefined && /[<[]/u.test(own.line)) return true;
  // A group whose declared default takes words of its own (`account site ls [account]`) hands it a word that names no
  // sub-verb, as a verb that takes words does: it is refused only as a near misspelling of a real sub-verb.
  return subverbsBelow(words).some(
    entry => entry.default === true && entry.words.length === words.length + 1 && (entry.args?.length ?? 0) > 0,
  );
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
          should(resolved.kind).equal(underAVerb(words) || hasDefault(words) ? 'subverb' : 'unknown');
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
        should(io.stderr()).containEql(
          underAVerb(words) || hasDefault(words) ? '"frobnicate" is not a sub-verb of' : 'unknown verb',
        );
        should(io.stdout()).equal('');
        should(transport.sent).deepEqual([]);
      }
    }
  });
});

/** The valued spellings a verb declares: `-s, --session <id>` is `-s` and `--session`; `--good | --clarify <text>` is `--clarify`. */
const valuedSpellings = (entry: VerbEntry): readonly string[] =>
  (entry.options ?? []).flatMap(option =>
    option.flag
      .split('|')
      .filter(alternative => alternative.includes('<'))
      .flatMap(alternative => alternative.split(',').map(part => part.trim().split(/\s+/u)[0] as string)),
  );

const entryOf = (words: readonly string[]): VerbEntry | undefined =>
  table.entries.find(entry => entry.words.join(' ') === words.join(' '));

describe('a valued option before a sub-verb: its value is never read as the verb', () => {
  const withValued = parents.flatMap(words => {
    const entry = entryOf(words);
    return entry === undefined || valuedSpellings(entry).length === 0 ? [] : [{ words, entry }];
  });

  it('should find parents that declare valued options (a registry that lost them would pass this vacuously)', () => {
    should(withValued.map(each => each.words.join(' '))).containEql('agenda');
  });

  for (const { words, entry } of withValued)
    describe(words.join(' '), () => {
      const children = subverbsBelow(words).filter(each => each.words.length === words.length + 1);
      for (const spelling of valuedSpellings(entry))
        it(`should read the word after ${spelling} as its value, even when that word is another sub-verb`, () => {
          // A child that is itself a parent goes on to look for ITS sub-verb, so only a leaf can be the one that runs.
          for (const child of children.filter(each => subverbsBelow(each.words).length === 0)) {
            const childWord = child.words.at(-1) as string;
            for (const decoy of children.map(each => each.words.at(-1) as string)) {
              const spaced = resolveVerb(table, [...words, spelling, decoy, childWord, 'x']);
              const chosen = spaced.kind === 'verb' ? spaced.entry.words.join(' ') : undefined;
              should(`${spelling} ${decoy} ${childWord} -> ${String(chosen)}`).equal(
                `${spelling} ${decoy} ${childWord} -> ${child.words.join(' ')}`,
              );
              if (spaced.kind === 'verb') should(spaced.rest).deepEqual([spelling, decoy, 'x']);
            }
            if (spelling.startsWith('--')) {
              const joined = resolveVerb(table, [...words, `${spelling}=${childWord}`, childWord, 'x']);
              should(joined.kind === 'verb' ? joined.entry.words.join(' ') : undefined).equal(child.words.join(' '));
            }
          }
        });
    });

  it('should declare on the parent every valued option its children declare (a target said before the sub-verb)', () => {
    const missing: string[] = [];
    for (const { words, entry } of withValued) {
      const declared = new Set(valuedSpellings(entry));
      for (const child of subverbsBelow(words).filter(each => each.words.length === words.length + 1))
        for (const spelling of valuedSpellings(child))
          if (!declared.has(spelling) && /^(--session|-s|--ferret)$/u.test(spelling))
            missing.push(`${words.join(' ')} lacks ${spelling} (declared by ${child.words.join(' ')})`);
    }
    should(missing).deepEqual([]);
  });

  it('should take `agenda --session done dismiss A1` as `dismiss A1` on the board "done", in every spelling', () => {
    for (const target of [['--session', 'done'], ['--session=done'], ['-s', 'done'], ['--ferret', 'done']]) {
      const resolved = resolveVerb(table, ['agenda', ...target, 'dismiss', 'A1']);
      should(resolved.kind).equal('verb');
      if (resolved.kind !== 'verb') return;
      should(resolved.entry.words).deepEqual(['agenda', 'dismiss']);
      should(resolved.rest).deepEqual([...target, 'A1']);
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
