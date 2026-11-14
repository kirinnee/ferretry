import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { bootRealDaemon, type RealDaemon } from './support/real-daemon.ts';

/**
 * `fy agenda` against a REAL 5.0 daemon (support/real-daemon.ts): the real `fy` process, the real route spine, grants and
 * Asks engine, on a temp FY_HOME. The review of the first agenda round found three silent failures that a hand-written
 * board and a canned POST could never show — a verb that exited 0 having done nothing, one that committed to the wrong
 * item, and a clear that said 1 and cleared 0 — so each is read back from the board the daemon serves afterwards.
 *
 * A ferret is seeded as an idle record with its own bearer (no pane, no model). `f1`…`f7` are autonomous leads, each test
 * group on its own (a session holds at most 10 open requests, and an owner's action on a ferret with no live agent comes
 * back to the owner as a card after a while, so groups must not share a board); `i1` is interactive; the owner is a run
 * with no session.
 */

setDefaultTimeout(120_000);

const OWNER_SAID = 'Please pick eu-west for the relay';
const OWNER_SAID_AT = '2026-11-13T09:00:00.000Z';

let daemon: RealDaemon;
beforeAll(async () => {
  daemon = await bootRealDaemon(
    [
      ...['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'].map(id => ({ id, mode: 'auto' as const })),
      { id: 'i1', mode: 'interactive' },
      // Boards named like sub-verbs: a target said before the sub-verb must never be read as one.
      { id: 'done', mode: 'auto' },
      { id: 'dismiss', mode: 'auto' },
    ],
    {
      // The owner has already said something to f1 (a daemon with no live agent will not take a send, so it is in the
      // queue file the way Conversation writes it); f5 has been told nothing.
      'state/conversation/f1/queue.jsonl': `${JSON.stringify({
        format: 1,
        v: 1,
        kind: 'enqueued',
        at: OWNER_SAID_AT,
        message: {
          v: 1,
          id: 'owner-msg-1',
          sender: 'human',
          text: OWNER_SAID,
          attachmentIds: [],
          enqueuedAt: OWNER_SAID_AT,
          state: 'read',
          stateAt: OWNER_SAID_AT,
          revision: 1,
        },
      })}\n`,
    },
  );
});

interface Item {
  readonly id: string;
  readonly subject?: string;
  readonly questionAnswer?: string;
}
interface Board {
  readonly items: readonly Item[];
  readonly resolved?: readonly Item[];
}

/** The words a ferret needs to raise one independent item. */
const raise = (title: string): string[] => [
  'agenda',
  'add',
  `Choose ${title}?`,
  '--title',
  title,
  '--premise',
  'A relay ships Friday',
  '--context',
  'Two regions are near',
  '--new',
  'An independent decision',
  '--json',
];

/** The board the daemon serves for `ferret`, as the owner reads it. */
const boardOf = async (ferret: string): Promise<Board> => {
  const read = await daemon.fy('owner', ['agenda', 'ls', '--session', ferret, '--json']);
  expect(read.code, read.err).toBe(0);
  return read.json as Board;
};

const openIds = async (ferret: string): Promise<string[]> => (await boardOf(ferret)).items.map(item => item.id);

afterAll(async () => await daemon?.dispose());

describe('fy agenda: an unknown sub-verb after flags is refused, a known one is run', () => {
  it('V-0030: should exit 2 for `agenda --json frobnicate` and name the real sub-verbs, and change nothing', async () => {
    const before = await openIds('f1');
    const ran = await daemon.fy('owner', ['agenda', '--json', 'frobnicate']);
    should(ran.code).equal(2);
    should(ran.err).containEql('"frobnicate" is not a sub-verb of agenda');
    should(ran.err).containEql('fy agenda add');
    should(ran.out).equal('');
    should(await openIds('f1')).deepEqual(before);
  });

  it('V-0031: should run `agenda --json add` as the add it names, not as the roll-up with the word thrown away', async () => {
    const ran = await daemon.fy('f1', [
      'agenda',
      '--json',
      'add',
      'Choose Flags first?',
      '--title',
      'Flags first',
      '--premise',
      'A relay ships Friday',
      '--context',
      'Two regions are near',
      '--new',
      'An independent decision',
    ]);
    expect(ran.code, ran.err).toBe(0);
    const board = await boardOf('f1');
    should(board.items.map(item => item.subject ?? '')).containEql('Choose Flags first?');
  });
});

describe('fy agenda answer: a switch never takes the word after it', () => {
  it('V-0032: should write the answer "A2" on A1 for `answer A1 --json A2`, and leave A2 untouched', async () => {
    const first = await daemon.fy('f2', raise('Answer target'));
    expect(first.code, first.err).toBe(0);
    const second = await daemon.fy('f2', raise('Answer bystander'));
    expect(second.code, second.err).toBe(0);
    const [a, b] = (await boardOf('f2')).items.slice(-2) as [Item, Item];
    const answered = await daemon.fy('f2', ['agenda', 'answer', a.id, '--json', 'the-text-word']);
    expect(answered.code, answered.err).toBe(0);
    const shownA = (await daemon.fy('f2', ['agenda', 'show', a.id, '--json'])).json as Item;
    const shownB = (await daemon.fy('f2', ['agenda', 'show', b.id, '--json'])).json as Item;
    should(shownA.questionAnswer).equal('the-text-word');
    should(shownB.questionAnswer).equal(undefined);
  });

  it('V-0053: should tick step 1 for `step <id> --undo 1 --json`, as v4 did', async () => {
    const made = await daemon.fy('f2', [...raise('Steps'), '--todo', '--step', 'Run the check']);
    expect(made.code, made.err).toBe(0);
    const id = ((made.json as Board).items.at(-1) as Item).id;
    const ticked = await daemon.fy('f2', ['agenda', 'step', id, '1', '--json']);
    expect(ticked.code, ticked.err).toBe(0);
    const unticked = await daemon.fy('f2', ['agenda', 'step', id, '--undo', '1', '--json']);
    expect(unticked.code, unticked.err).toBe(0);
  });
});

describe('fy agenda: nothing a verb was given is ignored', () => {
  it('V-0037: should refuse an unknown flag on edit and write nothing', async () => {
    const made = await daemon.fy('f3', raise('Typed flag'));
    const id = ((made.json as Board).items.at(-1) as Item).id;
    const ran = await daemon.fy('f3', ['agenda', 'edit', id, '--title', 'Changed title', '--no-such-flag', '--json']);
    should(ran.code).equal(1);
    should(ran.err).containEql('unknown option --no-such-flag');
    const shown = (await daemon.fy('f3', ['agenda', 'show', id, '--json'])).json as { title?: string };
    should(shown.title).not.equal('Changed title');
  });

  it('V-0035: should refuse a second id on dismiss and dismiss neither', async () => {
    const one = await daemon.fy('f3', raise('Dismiss one'));
    const two = await daemon.fy('f3', raise('Dismiss two'));
    expect(one.code, one.err).toBe(0);
    expect(two.code, two.err).toBe(0);
    const [a, b] = ((two.json as Board).items as readonly Item[]).slice(-2) as [Item, Item];
    const ran = await daemon.fy('f3', ['agenda', 'dismiss', a.id, b.id, '--json']);
    should(ran.code).equal(1);
    should(ran.err).containEql('takes one word');
    should(await openIds('f3')).containEql(a.id);
    should(await openIds('f3')).containEql(b.id);
  });

  it('V-0041: should refuse a misspelt switch on ls', async () => {
    const ran = await daemon.fy('f3', ['agenda', 'ls', '--jsno']);
    should(ran.code).equal(1);
    should(ran.err).containEql('unknown option --jsno');
  });
});

describe('fy agenda patch: one document, read back from the daemon', () => {
  it('V-0045: should change the ask the owner reads, carrying the revision `show --yaml` printed', async () => {
    const made = await daemon.fy('f4', raise('Patch me'));
    expect(made.code, made.err).toBe(0);
    const id = ((made.json as Board).items.at(-1) as Item).id;
    const yaml = await daemon.fy('f4', ['agenda', 'show', id, '--yaml']);
    expect(yaml.code, yaml.err).toBe(0);
    const revision = /^revision:\s*(\S+)/mu.exec(yaml.out)?.[1];
    should(revision).be.a.String();
    const dir = await mkdtemp(join(tmpdir(), 'fy-agenda-patch-'));
    try {
      const file = join(dir, 'patch.json');
      await writeFile(file, JSON.stringify({ revision, summary: 'Which destination now?' }));
      const patched = await daemon.fy('f4', ['agenda', 'patch', id, '--file', file, '--json']);
      expect(patched.code, patched.err).toBe(0);
      const shown = (await daemon.fy('f4', ['agenda', 'show', id, '--json'])).json as { subject?: string };
      should(shown.subject).equal('Which destination now?');
      // The same revision again is stale: the daemon refuses it and nothing is written.
      await writeFile(file, JSON.stringify({ revision, summary: 'Stale write' }));
      const stale = await daemon.fy('f4', ['agenda', 'patch', id, '--file', file, '--json']);
      should(stale.code).equal(1);
      const after = (await daemon.fy('f4', ['agenda', 'show', id, '--json'])).json as { subject?: string };
      should(after.subject).equal('Which destination now?');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('fy agenda log: the owner’s own words are copied from the chat, not retyped', () => {
  it('V-0040: should refuse while the owner has said nothing to this ferret, naming that', async () => {
    const made = await daemon.fy('f5', raise('Log nothing yet'));
    const id = ((made.json as Board).items.at(-1) as Item).id;
    const ran = await daemon.fy('f5', ['agenda', 'log', id, '--reply', 'Use eu-west', '--json']);
    should(ran.code).equal(1);
    should(ran.err).containEql('no message');
  });

  it('V-0040: should log the owner’s latest message onto the item once they have sent one', async () => {
    const made = await daemon.fy('f1', raise('Log what they said'));
    const id = ((made.json as Board).items.at(-1) as Item).id;
    const said = OWNER_SAID;
    const logged = await daemon.fy('f1', ['agenda', 'log', id, '--reply', 'eu-west it is', '--json']);
    expect(logged.code, logged.err).toBe(0);
    const conversation = await daemon.fy('f1', ['agenda', 'show', id, '--json']);
    should(JSON.stringify(conversation.json)).containEql(said);
  });
});

describe('fy queue: a ferret that does not exist is not an empty queue', () => {
  it('should exit non-zero for a typo, and still read the queue of a real ferret', async () => {
    const typo = await daemon.fy('owner', ['queue', 'frobnicate']);
    should(typo.code).not.equal(0);
    const real = await daemon.fy('owner', ['queue', 'f1']);
    should(real.code).equal(0);
  });
});

describe('fy agenda: the item verbs change the board the daemon serves', () => {
  it('V-0036, V-0037, V-0035, V-0038, V-0050: should edit, then dismiss, then done three items, each read back', async () => {
    const one = await daemon.fy('f6', raise('Rename the relay'));
    expect(one.code, one.err + one.out).toBe(0);
    const two = await daemon.fy('f6', raise('Cache sizing'));
    expect(
      two.code,
      `${two.err.slice(-300)} open=${JSON.stringify(await openIds('f6'))} resolved=${JSON.stringify(((await boardOf('f6')).resolved ?? []).map(item => item.id))}`,
    ).toBe(0);
    const [a, b] = ((two.json as Board).items as readonly Item[]).slice(-2) as [Item, Item];
    expect(one.code, one.err).toBe(0);
    const edited = await daemon.fy('f6', ['agenda', 'edit', a.id, '--title', 'A better title', '--json']);
    expect(edited.code, edited.err).toBe(0);
    const shown = await daemon.fy('f6', ['agenda', 'show', a.id, '--json']);
    expect(shown.code, shown.err + shown.out).toBe(0);
    should((shown.json as { title?: string }).title).equal('A better title');
    const dismissed = await daemon.fy('f6', ['agenda', 'dismiss', a.id, '--note', 'No longer needed', '--json']);
    expect(dismissed.code, dismissed.err).toBe(0);
    const closed = await daemon.fy('f6', ['agenda', 'done', b.id, '--reason', 'Settled', '--json']);
    expect(closed.code, closed.err).toBe(0);
    should(await openIds('f6')).not.containEql(a.id);
    should(await openIds('f6')).not.containEql(b.id);
    const history = await daemon.fy('f6', ['agenda', 'history', '--json']);
    expect(history.code, history.err).toBe(0);
    const resolved = ((history.json as Board).resolved ?? []).map(item => item.id);
    should(resolved).containEql(a.id);
    should(resolved).containEql(b.id);
  });
});

describe('fy agenda clear --agents: it clears what the dry run listed, or says it did not', () => {
  it('V-0033: should dismiss the open ask of an autonomous lead, count it, and leave the board empty', async () => {
    const f2 = await daemon.fy('f7', raise('Backlog'));
    expect(f2.code, f2.err).toBe(0);
    const listed = await daemon.fy('owner', ['agenda', 'clear', '--agents', '--dry-run']);
    expect(listed.code, listed.err).toBe(0);
    const said = /would clear (\d+) open asks? on (\d+) agent ferrets?/u.exec(listed.out);
    should(said).not.equal(null);
    const [, asks, ferrets] = said as RegExpExecArray;
    const cleared = await daemon.fy('owner', ['agenda', 'clear', '--agents', '--yes', '--json']);
    should(cleared.code).equal(0);
    should(cleared.json).deepEqual({ cleared: Number(asks), ferrets: Number(ferrets) });
    should(Number(asks)).be.above(0);
    should(await openIds('f7')).deepEqual([]);
  });

  it('V-0033: should never read an interactive ferret’s board', async () => {
    const own = await daemon.fy('i1', raise('Interactive ask'));
    expect(own.code, own.err).toBe(0);
    const ran = await daemon.fy('owner', ['agenda', 'clear', '--agents', '--yes', '--json']);
    should(ran.code).equal(0);
    should(await openIds('i1')).have.length(1);
  });
});

describe('fy agenda: a target said before the sub-verb is the target, never the verb', () => {
  const forms: readonly (readonly [string, readonly string[]])[] = [
    ['--session f1', ['--session', 'f1']],
    ['--session=f1', ['--session=f1']],
    ['-s f1', ['-s', 'f1']],
    ['--ferret f1', ['--ferret', 'f1']],
  ];
  for (const [label, target] of forms)
    it(`V-0041: should list f1's agenda for \`agenda ${label} ls --json\`, as it does for \`agenda ls ${label}\``, async () => {
      const expected = await openIds('f1');
      const ran = await daemon.fy('owner', ['agenda', ...target, 'ls', '--json']);
      expect(ran.code, ran.err).toBe(0);
      should((ran.json as Board).items.map(item => item.id)).deepEqual(expected);
    });

  it('V-0035: should dismiss A1 on the board named "done", not resolve it on the board named "dismiss"', async () => {
    const target = await daemon.fy('done', raise('Target board'));
    expect(target.code, target.err).toBe(0);
    const bystander = await daemon.fy('dismiss', raise('Bystander board'));
    expect(bystander.code, bystander.err).toBe(0);
    const [targetItem] = (await boardOf('done')).items as readonly [Item];
    const [bystanderItem] = (await boardOf('dismiss')).items as readonly [Item];
    should(targetItem.id).equal(bystanderItem.id);
    const ran = await daemon.fy('owner', [
      'agenda',
      '--session',
      'done',
      'dismiss',
      targetItem.id,
      '--note',
      'review closed',
      '--json',
    ]);
    expect(ran.code, ran.err).toBe(0);
    should(await openIds('done')).deepEqual([]);
    should(await openIds('dismiss')).deepEqual([bystanderItem.id]);
    const history = (await daemon.fy('owner', ['agenda', 'history', '--session', 'done', '--json'])).json as Board;
    should((history.resolved ?? []).map(item => item.id)).containEql(targetItem.id);
  });

  it('V-0030: should still refuse an unknown sub-verb after a target, and write to no board', async () => {
    const before = await openIds('f1');
    const ran = await daemon.fy('owner', ['agenda', '--session', 'f1', 'frobnicate']);
    should(ran.code).equal(2);
    should(ran.err).containEql('"frobnicate" is not a sub-verb of agenda');
    should(await openIds('f1')).deepEqual(before);
  });
});
