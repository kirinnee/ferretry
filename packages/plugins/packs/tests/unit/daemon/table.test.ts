import { describe, it } from 'bun:test';
import type { FerretState, FerretSummary, SitrepLine } from '@ferretry/core-ferrets/contract';
import type { Instant } from '@ferretry/std';
import should from 'should';
import { PACK_ENDED_WINDOW_MS, PackTableSchema } from '../../../contract/index.ts';
import {
  EXCERPT_WITHHELD,
  oneLine,
  PACK_TABLE_LIMITS,
  type PackTableLimits,
  packMembers,
  packRowState,
  readPackTable,
} from '../../../daemon/lib/table.ts';

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const at = (minutesAgo: number): Instant => new Date(NOW - minutesAgo * 60_000).toISOString() as Instant;

const ferret = (
  id: string,
  extra: Partial<Omit<FerretSummary, 'id'>> & { readonly state?: FerretState } = {},
): FerretSummary => ({
  id: id as FerretSummary['id'],
  name: id,
  role: 'helper',
  harness: 'claude-code',
  runner: 'tmux',
  folder: '/work',
  state: 'working',
  createdAt: at(300),
  stateAt: at(1),
  ...extra,
});

const ROOT = ferret('lead', { role: 'lead' });
const build = async (
  ferrets: readonly FerretSummary[],
  lines: Readonly<Record<string, readonly SitrepLine[]>> = {},
  blockers: Readonly<Record<string, number>> = {},
  options: {
    readonly redact?: (texts: readonly string[]) => Promise<readonly string[]>;
    readonly model?: (ferret: string) => Promise<string | undefined>;
  } = {},
) =>
  await readPackTable({
    root: ROOT,
    ferrets,
    sitrep: async id => ({ lines: lines[id] ?? [], blockers: blockers[id] ?? 0 }),
    redact: options.redact ?? (async texts => texts),
    ...(options.model === undefined ? {} : { model: options.model }),
    nowMs: NOW,
  });

describe('oneLine', () => {
  it('should take the first non-blank line, collapse whitespace and cut with an ellipsis', () => {
    should(oneLine('\n  hello   there \nsecond')).equal('hello there');
    should(oneLine('x'.repeat(150)).length).equal(100);
    should(oneLine('x'.repeat(150)).endsWith('…')).be.true();
    should(oneLine('   ')).equal('');
  });
});

describe('packRowState', () => {
  it('should say running, waiting, needs-you or ended', () => {
    should(packRowState('starting', 0)).equal('running');
    should(packRowState('working', 3)).equal('running');
    should(packRowState('idle', 0)).equal('waiting');
    should(packRowState('idle', 2)).equal('needs-you');
    should(packRowState('stopped', 2)).equal('ended');
  });
});

describe('packMembers', () => {
  it('should list helpers in tree order, depth from the root, and not the root or other leads’ helpers', () => {
    // Arrange
    const ferrets = [
      ferret('b', { parent: 'lead' as FerretSummary['id'], name: 'Beta' }),
      ferret('a', { parent: 'lead' as FerretSummary['id'], name: 'Alpha' }),
      ferret('a2', { parent: 'a' as FerretSummary['id'], name: 'Alpha child' }),
      ferret('x', { parent: 'other' as FerretSummary['id'] }),
    ];

    // Act
    const members = packMembers(ferrets, 'lead', NOW);

    // Assert
    should(members.map(member => [member.ferret.id, member.depth])).deepEqual([
      ['a', 1],
      ['a2', 2],
      ['b', 1],
    ]);
  });

  it('should keep an ended ferret only while it ended inside the window, and still list its live helper', () => {
    // Arrange
    const ferrets = [
      ferret('recent', { parent: 'lead' as FerretSummary['id'], state: 'stopped', stateAt: at(10) }),
      ferret('old', {
        parent: 'lead' as FerretSummary['id'],
        state: 'stopped',
        stateAt: at(PACK_ENDED_WINDOW_MS / 60_000 + 5),
      }),
      ferret('orphan', { parent: 'old' as FerretSummary['id'] }),
    ];

    // Act
    const ids = packMembers(ferrets, 'lead', NOW).map(member => member.ferret.id);

    // Assert
    should(ids).deepEqual(['orphan', 'recent']);
  });

  it('should terminate on a parent cycle', () => {
    const ferrets = [
      ferret('a', { parent: 'b' as FerretSummary['id'] }),
      ferret('b', { parent: 'a' as FerretSummary['id'] }),
      ferret('c', { parent: 'lead' as FerretSummary['id'] }),
    ];
    should(packMembers(ferrets, 'lead', NOW).map(member => member.ferret.id)).deepEqual(['c']);
  });
});

describe('readPackTable', () => {
  it('should build rows a reader can parse: state, card, newest line and when it ended', async () => {
    // Arrange
    const ferrets = [
      ferret('w', {
        parent: 'lead' as FerretSummary['id'],
        runtime: 'claude-main' as FerretSummary['runtime'],
        model: 'opus-5.5',
      }),
      ferret('i', { parent: 'lead' as FerretSummary['id'], state: 'idle' }),
      ferret('e', { parent: 'lead' as FerretSummary['id'], state: 'stopped', stateAt: at(5) }),
    ];
    const lines = {
      w: [
        {
          kind: 'card',
          text: 'Fix the bug',
          ref: '&F7',
          lane: 'Implement',
          pr: { number: 42, url: 'https://github.com/o/r/pull/42', state: 'open', draft: false, checks: 'passing' },
        },
        { kind: 'doing', text: 'running tests\nsecond line', at: at(3) },
        { kind: 'note', text: 'halfway', at: at(3) },
      ] satisfies SitrepLine[],
    };

    // Act
    const table = await build(ferrets, lines, { i: 1 });

    // Assert
    should(PackTableSchema.safeParse(table).success).be.true();
    should(table.root).deepEqual({ id: 'lead', name: 'lead' });
    should(table.at).equal(new Date(NOW).toISOString());
    const [e, i, w] = table.rows;
    // The MODEL column is the model it runs, never its runtime; the PR and the card's lane come from the card line.
    should(w).containEql({
      id: 'w',
      model: 'opus-5.5',
      state: 'running',
      depth: 1,
      card: { ref: '&F7', lane: 'Implement' },
      pr: { number: 42, url: 'https://github.com/o/r/pull/42', state: 'open', draft: false, checks: 'passing' },
    });
    should(w?.last).deepEqual({ at: at(3), source: 'note', text: 'halfway' });
    should(i?.state).equal('needs-you');
    should(i?.model).equal('default');
    should(i?.pr).be.undefined();
    should(e).containEql({ state: 'ended', endedAt: at(5), ferretState: 'stopped' });
  });

  it('should show the model each ferret is actually running: observed over requested, and an observed one for a default launch', async () => {
    // Arrange: w was asked for opus but switched inside its session; d asked for nothing and the harness reports one.
    const ferrets = [
      ferret('w', { parent: 'lead' as FerretSummary['id'], model: 'opus-5.5' }),
      ferret('d', { parent: 'lead' as FerretSummary['id'] }),
      ferret('u', { parent: 'lead' as FerretSummary['id'] }),
      ferret('k', { parent: 'lead' as FerretSummary['id'], model: 'glm-5.3' }),
    ];
    const observed: Record<string, string | undefined> = { w: 'sonnet-5.5', d: 'haiku-5.5' };

    // Act
    const table = await build(ferrets, {}, {}, { model: async id => observed[id] });

    // Assert: a ferret the reader cannot speak for shows the model it was started with, else `default` — never its runtime.
    const modelOf = (id: string) => table.rows.find(row => row.id === id)?.model;
    should(modelOf('w')).equal('sonnet-5.5');
    should(modelOf('d')).equal('haiku-5.5');
    should(modelOf('u')).equal('default');
    should(modelOf('k')).equal('glm-5.3');
  });

  it('should keep the newer of two lines, and a note over a message that is as new', async () => {
    // Arrange
    const ferrets = [
      ferret('a', { parent: 'lead' as FerretSummary['id'] }),
      ferret('b', { parent: 'lead' as FerretSummary['id'] }),
    ];
    const lines = {
      a: [
        { kind: 'doing', text: 'newer', at: at(1) },
        { kind: 'doing', text: 'older', at: at(10) },
      ] satisfies SitrepLine[],
      b: [
        { kind: 'doing', text: 'a message', at: at(2) },
        { kind: 'note', text: 'a note', at: at(2) },
        { kind: 'doing', text: 'another message', at: at(2) },
      ] satisfies SitrepLine[],
    };

    // Act
    const table = await build(ferrets, lines);

    // Assert
    should(table.rows.find(row => row.id === 'a')?.last).deepEqual({ at: at(1), source: 'message', text: 'newer' });
    should(table.rows.find(row => row.id === 'b')?.last).deepEqual({ at: at(2), source: 'note', text: 'a note' });
  });

  it('should show no newest line when a line has no time and the ferret’s own state time is unreadable', async () => {
    // Arrange
    const ferrets = [ferret('a', { parent: 'lead' as FerretSummary['id'], stateAt: 'not a time' as Instant })];
    const lines = { a: [{ kind: 'doing', text: 'undated' }] satisfies SitrepLine[] };

    // Act
    const table = await build(ferrets, lines);

    // Assert
    should(table.rows[0]?.last).be.undefined();
  });

  it('should list a member whose sitrep cannot be read, as if it had none', async () => {
    // Arrange
    const ferrets = [ferret('a', { parent: 'lead' as FerretSummary['id'] })];

    // Act
    const table = await readPackTable({
      root: ROOT,
      ferrets,
      sitrep: async () => {
        throw new Error('the sitrep is damaged');
      },
      redact: async texts => texts,
      nowMs: NOW,
    });

    // Assert
    should(table.rows.map(row => row.id)).deepEqual(['a']);
    should(table.rows[0]?.last).be.undefined();
    should(table.rows[0]?.card).be.undefined();
  });

  it('should be an empty table for a lead with no helpers', async () => {
    should((await build([])).rows).deepEqual([]);
  });

  it('should mask a WHOLE line before cutting it, so a secret that straddles column 100 shows none of itself', async () => {
    // Arrange: the secret starts at column 85, so the 99-character cut would keep its first 14 characters.
    const secret = 'sk-live-0123456789abcdefghijklmnopqrstuvwxyz';
    const text = `${'d'.repeat(85)}${secret} and the rest of the note`;
    const masked: string[] = [];
    const redact = async (texts: readonly string[]): Promise<readonly string[]> => {
      masked.push(...texts);
      return texts.map(line => line.replaceAll(secret, '[secret]'));
    };

    // Act
    const table = await build(
      [ferret('w', { parent: 'lead' as FerretSummary['id'] })],
      { w: [{ kind: 'note', text, at: at(1) }] },
      {},
      { redact },
    );

    // Assert: the masker saw the whole line; the row carries no fragment of the secret.
    should(masked).deepEqual([text]);
    const last = table.rows[0]?.last?.text ?? '';
    should(last).startWith('d'.repeat(85));
    should(last).containEql('[secret]');
    for (let length = 4; length <= secret.length; length += 1) should(last).not.containEql(secret.slice(0, length));
  });

  it('should withhold every excerpt, never the raw text, when the redactor fails', async () => {
    // Arrange
    const ferrets = [
      ferret('w', { parent: 'lead' as FerretSummary['id'] }),
      ferret('v', { parent: 'lead' as FerretSummary['id'] }),
    ];
    const lines = {
      w: [{ kind: 'note', text: 'token sk-abc', at: at(1) }] satisfies SitrepLine[],
      v: [{ kind: 'doing', text: 'deploying', at: at(2) }] satisfies SitrepLine[],
    };

    // Act
    const table = await build(
      ferrets,
      lines,
      {},
      { redact: async () => await Promise.reject(new Error('vault shut')) },
    );

    // Assert
    should(table.rows.map(row => row.last?.text)).deepEqual([EXCERPT_WITHHELD, EXCERPT_WITHHELD]);
    should(JSON.stringify(table)).not.containEql('sk-abc');
  });

  it('should read at most `concurrency` sitreps at once, excerpt at most `excerptRows` rows and skip text past the byte budget', async () => {
    // Arrange
    const ferrets = Array.from({ length: 6 }, (_, index) =>
      ferret(`h${String(index)}`, { parent: 'lead' as FerretSummary['id'] }),
    );
    let inFlight = 0;
    let peak = 0;
    const limits: PackTableLimits = { concurrency: 2, excerptRows: 4, endedRows: 0, textBytes: 25, rowBytes: 20 };
    const texts: Record<string, string> = {
      h0: 'short',
      h1: 'x'.repeat(21),
      h2: 'ten chars!',
      h3: 'more than the rest',
    };

    // Act
    const table = await readPackTable(
      {
        root: ROOT,
        ferrets,
        sitrep: async id => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await Promise.resolve();
          inFlight -= 1;
          const text = texts[id] ?? `line of ${id}`;
          return { lines: [{ kind: 'note', text, at: at(1) }], blockers: 0 };
        },
        redact: async lines => lines,
        nowMs: NOW,
      },
      limits,
    );

    // Assert: h1 is longer than one row's budget, h3 no longer fits the table's, h4 and h5 are past excerptRows.
    should(peak).be.belowOrEqual(2);
    should(table.rows.map(row => row.last?.text)).deepEqual([
      'short',
      undefined,
      'ten chars!',
      undefined,
      undefined,
      undefined,
    ]);
    should(PACK_TABLE_LIMITS).containEql({ concurrency: 4, excerptRows: 64, endedRows: 8 });
  });
});
