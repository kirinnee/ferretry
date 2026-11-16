import { describe, it } from 'bun:test';
import type { CloneReview, CloneReviewItem, CloneReviewLogin } from '@ferretry/plugin-runtimes/contract';
import should from 'should';
import {
  cloneNeedsYes,
  loginProblems,
  parseLoginFlags,
  renderCloneDiff,
  renderItemDetail,
  resolveCloneChoices,
} from '../../src/lib/machine/clone-update.ts';

const item = (ref: string, outcome: string, extra: object = {}): CloneReviewItem =>
  ({ ref, kind: 'mcp', outcome, match: 'key', files: [], ...extra }) as CloneReviewItem;

const login = (sourceId: string, outcome: string, extra: object = {}): CloneReviewLogin =>
  ({ sourceId, outcome, ...extra }) as CloneReviewLogin;

const reviewOf = (
  items: CloneReviewItem[],
  logins: CloneReviewLogin[] = [],
  over: Partial<CloneReview> = {},
): CloneReview =>
  ({
    mode: 'update',
    source: { name: 'desktop', lastCopiedAt: '2026-10-28T00:00:00.000Z', verified: 'self' },
    items,
    settings: [],
    logins,
    keys: [],
    same: { count: 0, probable: 0 },
    fingerprint: 'fp',
    ...over,
  }) as CloneReview;

const none = { theirs: [], mine: [], remove: [], skip: [] };
const options = { decisions: {}, logins: {}, binaryName: 'fy' };

describe('the choice flags of a repeat copy', () => {
  it('names the flags an item answers to when the one used does not fit it', () => {
    const review = reviewOf([item('mcp/b', 'theirs')]);

    const resolved = resolveCloneChoices(review, { ...none, remove: ['mcp/b'] });

    should(resolved.decisions).deepEqual({});
    should(resolved.problems).deepEqual([
      '--remove mcp/b: only the other machine changed it, so there is nothing to remove. For it you can use --theirs or --mine or --skip.',
    ]);
  });

  it('refuses an item named by two different flags, and takes neither', () => {
    const review = reviewOf([item('mcp/b', 'theirs')]);

    const resolved = resolveCloneChoices(review, { ...none, theirs: ['mcp/b'], mine: ['mcp/b'] });

    should(resolved.problems).deepEqual(['mcp/b is named by both --theirs and --mine. Pick one.']);
    should(resolved.decisions).deepEqual({ 'mcp/b': 'take' });
  });
});

describe('the --login answers of a repeat copy', () => {
  it('refuses a login the other machine’s setup does not have', () => {
    should(loginProblems(reviewOf([], [login('work', 'ask', { candidates: ['a'] })]), { ghost: 'a' })).deepEqual([
      "--login ghost: the other machine's setup has no login called ghost.",
    ]);
  });

  it('refuses an answer for a login that is already settled, saying how', () => {
    const review = reviewOf(
      [],
      [login('one', 'matched', { target: 'work' }), login('two', 'matched'), login('three', 'slot')],
    );

    should(loginProblems(review, { one: 'x', two: 'x', three: 'x' })).deepEqual([
      '--login one: it is already settled (used as work), so there is nothing to answer.',
      '--login two: it is already settled (used as the one here), so there is nothing to answer.',
      '--login three: it is already settled (a new empty slot), so there is nothing to answer.',
    ]);
  });

  it('reads --login source=target pairs, and refuses a repeat and a malformed one', () => {
    should(parseLoginFlags(['work=a', ' home = slot '])).deepEqual({ work: 'a', home: 'slot' });
    should(() => parseLoginFlags(['work=a', 'work=b'])).throw('--login names work twice.');
    should(() => parseLoginFlags(['=a'])).throw(/^--login takes /u);
  });
});

describe('the review as the terminal prints it', () => {
  it('heads a first copy as a copy, and an update without a date as an update', () => {
    should(renderCloneDiff(reviewOf([], [], { mode: 'first' }), options).split('\n')[0]).equal('Copy from desktop');
    should(
      renderCloneDiff(
        reviewOf([], [], { source: { name: 'desktop', verified: 'self' } as CloneReview['source'] }),
        options,
      ).split('\n')[0],
    ).equal('Update from desktop');
  });

  it('says what changed in each document: added, removed, changed with and without a line count', () => {
    const text = renderCloneDiff(
      reviewOf([
        item('mcp/files', 'theirs', {
          files: [
            { path: 'mcp/files/new.sh', change: 'added' },
            { path: 'mcp/files/old.sh', change: 'removed' },
            { path: 'mcp/files/run.sh', change: 'changed', lines: { added: 3, removed: 1 } },
            { path: 'mcp/files/plain.sh', change: 'changed' },
          ],
        }),
      ]),
      options,
    );

    should(text).containEql('new.sh (new), old.sh (removed), run.sh: +3 −1 lines, plain.sh changed');
  });

  it('lists what a written item would run, a document line by line, and says what it needs', () => {
    const text = renderCloneDiff(
      reviewOf([
        item('mcp/notes', 'new', {
          runnable: {
            entries: [
              { label: 'command', text: 'notes-server --port 1', document: false },
              { label: 'hooks/guard.sh', text: 'echo one\necho two\n', document: true },
            ],
          },
          needs: ['mcp/base'],
        }),
      ]),
      options,
    );

    should(text.split('\n')).containDeepOrdered([
      '      Runs: command: notes-server --port 1',
      '      Runs: hooks/guard.sh, 2 lines:',
      '        echo one',
      '        echo two',
      '      Needs: mcp/base',
    ]);
  });

  it('says what the person decided where it differs from the daemon’s default', () => {
    const review = reviewOf([
      item('mcp/a', 'theirs', { choice: 'take' }),
      item('mcp/b', 'theirs', { choice: 'take' }),
      item('mcp/c', 'gone', { choice: 'keep' }),
      item('mcp/d', 'removed-here', { choice: 'keep' }),
      item('mcp/e', 'new', { choice: 'add' }),
      item('mcp/f', 'both'),
      item('mcp/g', 'both'),
      item('mcp/h', 'both'),
    ]);

    const text = renderCloneDiff(review, {
      ...options,
      decisions: {
        'mcp/a': 'skip',
        'mcp/b': 'keep',
        'mcp/c': 'remove',
        'mcp/d': 'add',
        'mcp/e': 'take',
        'mcp/f': 'take',
        'mcp/g': 'keep',
      },
    });

    should(text).containEql('mcp/a  left out');
    should(text).containEql('mcp/b  keeping yours');
    should(text).containEql('mcp/c  will be removed here');
    should(text).containEql('mcp/d  will be brought back');
    should(text.split('\n').find(line => line.includes('mcp/e'))).equal('  + mcp/e');
    should(text).containEql("mcp/f  taking desktop's");
    should(text).containEql('mcp/g  keeping yours');
    should(text).containEql('mcp/h  needs your choice');
  });

  it('says where each login stands: already here, a new slot, answered, or still to answer', () => {
    const configured = { entries: [{ label: 'env', text: 'TOKEN from the environment', document: false }] };
    const text = renderCloneDiff(
      reviewOf(
        [item('mcp/a', 'new')],
        [
          login('one', 'matched', { target: 'work' }),
          login('two', 'matched'),
          login('three', 'slot'),
          login('four', 'slot', { runnable: configured }),
          login('five', 'ask', { candidates: ['a', 'b'] }),
          login('six', 'ask', { candidates: ['a'], runnable: configured }),
          login('seven', 'ask', { candidates: ['a'] }),
        ],
      ),
      { ...options, logins: { five: 'b', seven: 'slot' } },
    );

    should(text.split('\n')).containDeepOrdered([
      'Logins',
      '  one → already here as work, no new sign-in',
      '  two → already here as a login here, no new sign-in',
      '  three → new empty slot, needs sign-in (fy login ls)',
      '  four → new login, configured to run the following',
      '      Runs: env: TOKEN from the environment',
      '  five → b, no new sign-in',
      '  six → could be any of a',
      '      choose with --login six=<one of those>, or --login six=slot for a new configured one, listed below',
      '      Runs: env: TOKEN from the environment',
      '  seven → new empty slot, needs sign-in (fy login ls)',
    ]);
  });

  it('shows one both-changed item in full: its fields, its note, and what it would run', () => {
    const text = renderItemDetail(
      item('mcp/notes', 'both', {
        match: 'probable',
        fields: ['command', 'args'],
        note: 'renamed on desktop',
        runnable: { entries: [{ label: 'command', text: 'notes-server', document: false }] },
      }),
      'desktop',
    );

    should(text.split('\n')).deepEqual([
      'mcp/notes — both sides changed it (matched by name only)',
      '  fields: command, args',
      '  renamed on desktop',
      '    Runs: command: notes-server',
      "  desktop's version is the one that would be copied; yours is what is here now.",
    ]);
  });
});

describe('when a repeat copy asks first', () => {
  it('asks when a login would be added configured for a runtime that is written, but not when the person left it out', () => {
    const configured = { entries: [{ label: 'env', text: 'TOKEN', document: false }] };
    const review = reviewOf(
      [item('runtime/work', 'new', { kind: 'runtime', choice: 'add' })],
      [login('one', 'slot', { runnable: configured })],
    );

    should(cloneNeedsYes(review, {}, {})).equal(true);
    should(cloneNeedsYes(review, { 'runtime/work': 'skip' }, {})).equal(false);
    should(cloneNeedsYes(review, {}, { one: 'work' })).equal(false);
  });
});
