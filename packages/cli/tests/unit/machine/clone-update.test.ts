import { describe, it } from 'bun:test';
import {
  CLONE_OUTCOMES,
  type CloneOutcome,
  type CloneReviewItem,
  type CloneReviewLogin,
  FleetCloneReviewSchema,
} from '@ferretry/protocol';
import should from 'should';
import {
  type CloneChoiceFlags,
  cloneNeedsYes,
  loginProblems,
  parseLoginFlags,
  pendingBoth,
  pendingLogins,
  renderCloneDiff,
  renderItemDetail,
  resolveCloneChoices,
} from '../../../src/lib/machine/clone-update.ts';
import { cloneReview } from '../fleet/account-fakes.ts';

const item = (ref: string, outcome: CloneOutcome, overrides: Partial<CloneReviewItem> = {}): CloneReviewItem => {
  const kind = ref.startsWith('profile/') ? 'profile' : ref.startsWith('runtime/') ? 'runtime' : 'mcp';
  const defaults: Record<CloneOutcome, CloneReviewItem['choice']> = {
    new: 'add',
    theirs: 'take',
    mine: 'keep',
    both: undefined,
    gone: 'keep',
    'removed-here': 'keep',
  };
  const choice = defaults[outcome];
  return {
    ref,
    kind,
    outcome,
    match: 'key',
    files: [],
    ...(choice === undefined ? {} : { choice }),
    ...overrides,
  };
};

const noFlags: CloneChoiceFlags = { theirs: [], mine: [], remove: [], skip: [] };
const flags = (overrides: Partial<CloneChoiceFlags>): CloneChoiceFlags => ({ ...noFlags, ...overrides });

/** One item of every outcome, the way a repeat copy from a changed source lists them. */
const everyOutcome = () =>
  cloneReview({
    mode: 'update',
    source: { name: 'studio-mac', lastCopiedAt: '2026-10-28T09:30:00.000Z', verified: 'self' },
    items: [
      item('mcp/notes', 'new', {
        runnable: {
          reference: 'mcp/notes',
          kind: 'mcp',
          name: 'notes',
          entries: [{ label: 'command', text: 'npx -y notes', document: false }],
        },
      }),
      item('profile/review', 'new'),
      item('hooks/guard', 'theirs', {
        kind: 'hooks',
        files: [{ path: 'components/hooks/guard/send.sh', change: 'changed', lines: { added: 3, removed: 1 } }],
      }),
      item('instructions/main', 'mine', { kind: 'instructions' }),
      item('settings/shared', 'both', { kind: 'settings', fields: ['args'] }),
      item('runtime/old-codex', 'gone'),
      item('profile/retired', 'removed-here'),
    ],
    logins: [
      { sourceId: 'claude-work', outcome: 'matched', target: 'claude-kirin' },
      { sourceId: 'codex-spare', outcome: 'slot' },
    ],
    same: { count: 14, probable: 3 },
  });

const render = (
  review = everyOutcome(),
  decisions: Record<string, 'take' | 'keep' | 'remove' | 'add' | 'skip'> = {},
  logins: Record<string, string> = {},
): string => renderCloneDiff(review, { decisions, logins, binaryName: 'fz' });

describe('resolveCloneChoices', () => {
  it('should turn each flag into the choice its item allows, by the ref as listed', () => {
    // Arrange
    const review = everyOutcome();

    // Act
    const resolved = resolveCloneChoices(
      review,
      flags({
        theirs: ['settings/shared', 'profile/retired'],
        mine: ['hooks/guard', 'runtime/old-codex'],
        skip: ['profile/review'],
      }),
    );

    // Assert
    should(resolved.problems).deepEqual([]);
    should(resolved.decisions).deepEqual({
      'settings/shared': 'take',
      'profile/retired': 'add',
      'hooks/guard': 'keep',
      'runtime/old-codex': 'keep',
      'profile/review': 'skip',
    });
  });

  it('should read --remove as remove, --theirs on a new item as add, and --skip on a changed one as keep', () => {
    // Act
    const resolved = resolveCloneChoices(
      everyOutcome(),
      flags({ remove: ['runtime/old-codex'], theirs: ['mcp/notes'], skip: ['settings/shared', 'hooks/guard'] }),
    );

    // Assert
    should(resolved.problems).deepEqual([]);
    should(resolved.decisions).deepEqual({
      'runtime/old-codex': 'remove',
      'mcp/notes': 'add',
      'settings/shared': 'keep',
      'hooks/guard': 'keep',
    });
  });

  it('should find an item by the name the source calls it when that is unambiguous', () => {
    // Arrange
    const review = cloneReview({
      mode: 'update',
      items: [
        item('mcp/notes-2', 'new', { sourceRef: 'mcp/notes' }),
        item('hooks/a', 'theirs', { sourceRef: 'hooks/shared' }),
        item('hooks/b', 'theirs', { sourceRef: 'hooks/shared' }),
      ],
    });

    // Act
    const unique = resolveCloneChoices(review, flags({ skip: ['mcp/notes'] }));
    const ambiguous = resolveCloneChoices(review, flags({ skip: ['hooks/shared'] }));

    // Assert
    should(unique.decisions).deepEqual({ 'mcp/notes-2': 'skip' });
    should(ambiguous.problems).have.length(1);
  });

  it('should refuse an item the review does not list, in words that say it may already be the same', () => {
    // Act
    const resolved = resolveCloneChoices(everyOutcome(), flags({ theirs: ['mcp/nothing'] }));

    // Assert
    should(resolved.problems).deepEqual([
      '--theirs mcp/nothing: nothing called mcp/nothing differs between the two machines. It may already be the same here.',
    ]);
    should(resolved.decisions).deepEqual({});
  });

  it('should refuse one item named by two different flags, and accept it named twice by the same one', () => {
    // Act
    const clash = resolveCloneChoices(
      everyOutcome(),
      flags({ theirs: ['settings/shared'], mine: ['settings/shared'] }),
    );
    const repeated = resolveCloneChoices(everyOutcome(), flags({ mine: ['settings/shared', 'settings/shared'] }));

    // Assert
    should(clash.problems).deepEqual(['settings/shared is named by both --theirs and --mine. Pick one.']);
    should(repeated.problems).deepEqual([]);
    should(repeated.decisions).deepEqual({ 'settings/shared': 'keep' });
  });

  it.each([
    ['mine', 'mcp/notes', /--mine mcp\/notes: it is new.*--theirs or --skip/u],
    [
      'remove',
      'hooks/guard',
      /--remove hooks\/guard: only the other machine changed it.*--theirs or --mine or --skip/u,
    ],
    ['theirs', 'runtime/old-codex', /--theirs runtime\/old-codex: the other machine no longer has it/u],
    ['theirs', 'instructions/main', /--theirs instructions\/main: only you changed it here/u],
    ['remove', 'settings/shared', /--remove settings\/shared: both machines changed it/u],
    ['remove', 'profile/retired', /--remove profile\/retired: you removed it here.*bring it back with --theirs/u],
  ] as const)('should refuse --%s on %s, saying why and what it can take', (flag, ref, expected) => {
    // Act
    const resolved = resolveCloneChoices(everyOutcome(), flags({ [flag]: [ref] }));

    // Assert
    should(resolved.problems).have.length(1);
    should(resolved.problems[0]).match(expected);
    should(resolved.decisions).deepEqual({});
  });

  it('should allow every outcome some flag, so nothing is a dead end', () => {
    for (const outcome of CLONE_OUTCOMES) {
      const review = cloneReview({ mode: 'update', items: [item('mcp/x', outcome)] });
      const any = [
        resolveCloneChoices(review, flags({ theirs: ['mcp/x'] })),
        resolveCloneChoices(review, flags({ mine: ['mcp/x'] })),
        resolveCloneChoices(review, flags({ remove: ['mcp/x'] })),
        resolveCloneChoices(review, flags({ skip: ['mcp/x'] })),
      ];
      should(any.some(resolved => resolved.problems.length === 0)).be.true();
    }
  });
});

describe('pendingBoth', () => {
  it('should list a both-changed item until a decision names it, and nothing else', () => {
    // Arrange
    const review = everyOutcome();

    // Act
    const before = pendingBoth(review, {});
    const after = pendingBoth(review, { 'settings/shared': 'keep' });

    // Assert
    should(before.map(one => one.ref)).deepEqual(['settings/shared']);
    should(after).deepEqual([]);
  });
});

describe('--login answers', () => {
  it('should read <source>=<target> pairs, including =slot', () => {
    should(parseLoginFlags(['claude-work=claude-kirin', 'codex-spare=slot'])).deepEqual({
      'claude-work': 'claude-kirin',
      'codex-spare': 'slot',
    });
    should(parseLoginFlags([])).deepEqual({});
  });

  it.each([['claude-work'], ['=slot'], ['claude-work=']])('should refuse "%s" as not a pair', value => {
    should(() => parseLoginFlags([value])).throw(/--login takes <source login>=<login here>/u);
  });

  it('should refuse a source login answered twice rather than let the last one win', () => {
    should(() => parseLoginFlags(['a=b', 'a=c'])).throw('--login names a twice.');
  });

  it('should list only the logins the daemon could not settle and nobody has answered', () => {
    // Arrange
    const ask: CloneReviewLogin = { sourceId: 'claude-work', outcome: 'ask', candidates: ['a', 'b'] };
    const review = cloneReview({
      logins: [ask, { sourceId: 'codex', outcome: 'matched', target: 'codex-me' }, { sourceId: 'x', outcome: 'slot' }],
    });

    // Act / Assert
    should(pendingLogins(review, {})).deepEqual([ask]);
    should(pendingLogins(review, { 'claude-work': 'a' })).deepEqual([]);
  });

  it('should refuse an answer for a login that is unknown, already settled, or not among the candidates', () => {
    // Arrange
    const review = cloneReview({
      logins: [
        { sourceId: 'claude-work', outcome: 'ask', candidates: ['a', 'b'] },
        { sourceId: 'codex', outcome: 'matched', target: 'codex-me' },
        { sourceId: 'spare', outcome: 'slot' },
      ],
    });

    // Act
    const problems = loginProblems(review, {
      nobody: 'a',
      codex: 'codex-other',
      spare: 'slot',
      'claude-work': 'c',
    });
    const fine = loginProblems(review, { 'claude-work': 'slot' });

    // Assert
    should(problems).deepEqual([
      "--login nobody: the other machine's setup has no login called nobody.",
      '--login codex: it is already settled (used as codex-me), so there is nothing to answer.',
      '--login spare: it is already settled (a new empty slot), so there is nothing to answer.',
      '--login claude-work=c: pick one of a, b, or slot for a new empty login.',
    ]);
    should(fine).deepEqual([]);
  });
});

/** A new runtime plus an environment login the copy would add, configured to run `--require /tmp/probe.cjs`. */
const withEnvironmentLogin = (outcome: 'slot' | 'ask' | 'matched' = 'slot') =>
  cloneReview({
    mode: 'update',
    items: [item('runtime/agent', 'new')],
    logins: [
      {
        sourceId: 'api',
        outcome,
        ...(outcome === 'ask' ? { candidates: ['api-a', 'api-b'] } : {}),
        ...(outcome === 'matched' ? { target: 'api-here' } : {}),
        runnable: {
          entries: [
            { label: 'harness', text: 'claude', document: false },
            { label: 'NODE_OPTIONS', text: '--require /tmp/probe.cjs', document: false },
          ],
        },
      },
    ],
  });

describe('cloneNeedsYes', () => {
  it('should ask before an environment login is added for a runtime that is written, whatever the login is called', () => {
    // Arrange
    const review = withEnvironmentLogin();

    // Act / Assert
    should(cloneNeedsYes(review, {}, {})).be.true();
    should(cloneNeedsYes(withEnvironmentLogin('ask'), {}, { api: 'slot' })).be.true();
    should(cloneNeedsYes(withEnvironmentLogin('ask'), {}, {})).be.true();
  });

  it('should not ask for an environment login nothing writes, one already here, or one the person pointed at a login here', () => {
    // Act / Assert
    should(cloneNeedsYes(withEnvironmentLogin(), { 'runtime/agent': 'skip' }, {})).be.false();
    should(cloneNeedsYes(withEnvironmentLogin('matched'), {}, {})).be.false();
    should(cloneNeedsYes(withEnvironmentLogin('ask'), {}, { api: 'api-b' })).be.false();
    should(
      cloneNeedsYes(
        cloneReview({ items: [item('runtime/agent', 'new')], logins: [{ sourceId: 'x', outcome: 'slot' }] }),
        {},
        {},
      ),
    ).be.false();
  });

  it('should ask before anything is removed or any command is brought in, and not before a plain update', () => {
    // Arrange
    const review = everyOutcome();
    const runs = review.items.filter(one => one.ref === 'mcp/notes');

    // Act / Assert
    should(cloneNeedsYes(review, {}, {})).be.true();
    should(cloneNeedsYes(review, { 'mcp/notes': 'skip', 'settings/shared': 'keep' }, {})).be.false();
    should(cloneNeedsYes(review, { 'mcp/notes': 'skip', 'runtime/old-codex': 'remove' }, {})).be.true();
    should(runs).have.length(1);
  });
});

describe('renderCloneDiff', () => {
  it('should print exactly the groups of the design, in order, with the counts and the same line', () => {
    should(render()).equal(
      [
        'Update from studio-mac (last copied 2026-10-28)',
        '',
        'New on studio-mac (2)   leave one out with --skip <item>',
        '  + mcp/notes',
        '      Runs: command: npx -y notes',
        '  + profile/review',
        'Changed on studio-mac (1)   keep yours instead with --mine <item>',
        '  ~ hooks/guard        send.sh: +3 −1 lines',
        'Changed here, kept (1)',
        '  = instructions/main',
        "Both changed — choose (1)   needs --theirs <item> to take studio-mac's, or --mine <item> to keep yours",
        '  ! settings/shared    args; needs your choice',
        'Gone from studio-mac — kept here (1)   use --remove <item> to remove',
        '  - runtime/old-codex',
        'Removed here — staying removed (1)   use --theirs <item> to bring one back',
        '  x profile/retired',
        'Logins',
        '  claude-work → already here as claude-kirin, no new sign-in',
        '  codex-spare → new empty slot, needs sign-in (fz credentials)',
        '14 things already the same (3 matched by name).',
      ].join('\n'),
    );
  });

  it('should say what a both-changed item will do once it is chosen, and what a changed choice does', () => {
    // Act
    const text = render(everyOutcome(), {
      'settings/shared': 'take',
      'hooks/guard': 'keep',
      'profile/review': 'skip',
      'runtime/old-codex': 'remove',
      'profile/retired': 'add',
    });

    // Assert
    should(text)
      .match(/! settings\/shared {4}args; taking studio-mac's\n/u)
      .and.match(/~ hooks\/guard {8}send\.sh: \+3 −1 lines; keeping yours\n/u)
      .and.match(/\+ profile\/review {5}left out\n/u)
      .and.match(/- runtime\/old-codex {2}will be removed here\n/u)
      .and.match(/x profile\/retired {4}will be brought back$/mu);
    should(render(everyOutcome(), { 'settings/shared': 'keep' })).match(/args; keeping yours\n/u);
  });

  it('should not list what a left-out item would run, and should list all of what a written one runs', () => {
    // Arrange
    const review = cloneReview({
      mode: 'update',
      items: [
        item('hooks/guard', 'new', {
          kind: 'hooks',
          runnable: {
            reference: 'hooks/guard',
            kind: 'hooks',
            name: 'guard',
            entries: [
              { label: 'command', text: 'sh send.sh', document: false },
              { label: 'components/hooks/guard/send.sh', text: 'echo one\necho two\n', document: true },
            ],
          },
        }),
      ],
    });

    // Act
    const written = render(review);
    const skipped = render(review, { 'hooks/guard': 'skip' });

    // Assert
    should(written).containEql('      Runs: command: sh send.sh');
    should(written).containEql(
      '      Runs: components/hooks/guard/send.sh, 2 lines:\n        echo one\n        echo two',
    );
    should(skipped).not.containEql('Runs:');
  });

  it('should show the files an item adds or removes, and a note and what an item needs', () => {
    // Arrange
    const review = cloneReview({
      mode: 'update',
      items: [
        item('hooks/guard', 'theirs', {
          kind: 'hooks',
          files: [
            { path: 'components/hooks/guard/new.sh', change: 'added' },
            { path: 'components/hooks/guard/old.sh', change: 'removed' },
            { path: 'components/hooks/guard/same.sh', change: 'changed' },
          ],
          note: 'probably the same item',
          needs: ['mcp/notes'],
        }),
      ],
    });

    // Act
    const text = render(review);

    // Assert
    should(text).containEql('new.sh (new), old.sh (removed), same.sh changed; probably the same item');
    should(text).containEql('      Needs: mcp/notes');
    should(render(review, { 'hooks/guard': 'remove' })).not.containEql('Needs:');
  });

  it('should list everything an environment login is configured with, and not call it an empty slot', () => {
    // Arrange
    const review = withEnvironmentLogin();

    // Act
    const text = render(review);

    // Assert
    should(text).containEql('  api → new login, configured to run the following\n');
    should(text).containEql('      Runs: harness: claude\n      Runs: NODE_OPTIONS: --require /tmp/probe.cjs');
    should(text).not.containEql('empty slot');
  });

  it('should list an environment login when it is asked about, and when the person answers it is a new login', () => {
    // Arrange
    const review = withEnvironmentLogin('ask');

    // Act
    const asking = render(review);
    const slot = render(review, {}, { api: 'slot' });

    // Assert
    should(asking).containEql('or --login api=slot for a new configured one, listed below');
    should(asking).containEql('      Runs: NODE_OPTIONS: --require /tmp/probe.cjs');
    should(slot).containEql('  api → new login, configured to run the following');
    should(slot).containEql('      Runs: NODE_OPTIONS: --require /tmp/probe.cjs');
  });

  it('should list nothing for an environment login that is already here, or that the person points at a login here', () => {
    // Act
    const matched = render(withEnvironmentLogin('matched'));
    const named = render(withEnvironmentLogin('ask'), {}, { api: 'api-b' });

    // Assert
    should(matched).containEql('  api → already here as api-here, no new sign-in').and.not.containEql('Runs:');
    should(named).containEql('  api → api-b, no new sign-in').and.not.containEql('Runs:');
  });

  it('should ask which login when the daemon could not tell, and show the answer once given', () => {
    // Arrange
    const review = cloneReview({
      mode: 'update',
      items: [item('profile/a', 'new')],
      logins: [{ sourceId: 'claude-work', outcome: 'ask', candidates: ['claude-a', 'claude-b'] }],
    });

    // Act
    const asking = render(review);
    const named = render(review, {}, { 'claude-work': 'claude-b' });
    const slot = render(review, {}, { 'claude-work': 'slot' });

    // Assert
    should(asking).containEql('  claude-work → could be any of claude-a, claude-b');
    should(asking).containEql('--login claude-work=<one of those>, or --login claude-work=slot for a new empty one');
    should(named).containEql('  claude-work → claude-b, no new sign-in');
    should(slot).containEql('  claude-work → new empty slot, needs sign-in (fz credentials)');
  });

  it('should say there is nothing to copy when nothing differs, and still count what is the same', () => {
    // Arrange
    const review = cloneReview({
      mode: 'update',
      source: { name: 'studio-mac', verified: 'self' },
      logins: [{ sourceId: 'claude-work', outcome: 'matched', target: 'claude-kirin' }],
      same: { count: 1, probable: 0 },
    });

    // Act
    const text = render(review);

    // Assert
    should(text).equal(
      [
        'Update from studio-mac',
        '',
        'Logins',
        '  claude-work → already here as claude-kirin, no new sign-in',
        'Everything from studio-mac is already here. Nothing to copy.',
        '1 thing already the same.',
      ].join('\n'),
    );
  });

  it('should head a first copy as a copy, not an update', () => {
    should(render(cloneReview({ items: [item('profile/a', 'new')] }))).startWith('Copy from laptop\n');
  });

  it('should print a review that parses with the review schema, the same one --json prints', () => {
    should(FleetCloneReviewSchema.safeParse(everyOutcome()).success).be.true();
  });
});

describe('renderItemDetail', () => {
  it('should show what differs, what it would run, and which side is which', () => {
    // Arrange
    const both = item('settings/shared', 'both', {
      kind: 'settings',
      match: 'probable',
      files: [{ path: 'components/settings/shared.json', change: 'changed', lines: { added: 1, removed: 2 } }],
      note: 'we cannot tell which side changed',
      runnable: {
        reference: 'settings/shared',
        kind: 'settings',
        name: 'shared',
        entries: [{ label: 'args', text: '--verbose', document: false }],
      },
    });

    // Act
    const text = renderItemDetail(both, 'studio-mac');

    // Assert
    should(text).equal(
      [
        'settings/shared — both sides changed it (matched by name only)',
        '  shared.json: +1 −2 lines',
        '  we cannot tell which side changed',
        '    Runs: args: --verbose',
        "  studio-mac's version is the one that would be copied; yours is what is here now.",
      ].join('\n'),
    );
  });

  it('should fall back to the changed fields when there is no document', () => {
    // Act
    const text = renderItemDetail(item('mcp/notes', 'both', { fields: ['command', 'args'] }), 'studio-mac');

    // Assert
    should(text).containEql('  fields: command, args');
  });
});
