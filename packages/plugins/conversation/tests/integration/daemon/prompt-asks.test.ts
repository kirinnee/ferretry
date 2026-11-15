import { describe, expect, test } from 'bun:test';
import type { AskDraft, AskRef, AskSummary } from '@ferretry/core-asks/contract';
import { PromptAsks, type PromptAsksPort } from '../../../daemon/prompts/adapters/prompt-asks.ts';
import { promptEntry, type PromptRead } from '../../../daemon/prompts/lib/prompt-wait.ts';

const permission = { id: '0123456789abcdef', tool: 'Bash', what: 'ls', question: 'Do you want to proceed?' };
const parked = (id = permission.id): PromptRead => ({
  turnState: 'needs-input',
  permissionRequest: { ...permission, id },
});

/** The board as far as prompt cards go: what is open, what was raised, what was closed and why. */
function board(failRaise = false) {
  const open: AskSummary[] = [];
  const raised: AskDraft[] = [];
  const closed: string[] = [];
  const port: PromptAsksPort = {
    raise: async draft => {
      if (failRaise) throw new Error('asks is down');
      raised.push(draft);
      open.push({ ferret: draft.ferret, id: `A${raised.length}`, entry: draft.entry } as AskSummary);
      return { ferret: draft.ferret ?? '', id: `A${raised.length}` } as AskRef;
    },
    open: async () => [...open],
    close: async (ref, reason, entry) => {
      closed.push(`${ref.ferret} ${reason} ${String(entry)}`);
      open.splice(0, open.length, ...open.filter(ask => ask.id !== ref.id));
    },
  };
  return { open, raised, closed, port };
}

const rosterOf = (...live: boolean[]) => live.map((isLive, index) => ({ id: `f${index + 1}`, live: isLive }));

describe('a ferret parked on a prompt', () => {
  test('has one card raised for it, once however often it is looked at, and it is cleared when the wait ends', async () => {
    const { port, raised, closed } = board();
    let read: PromptRead | undefined = parked();
    const asks = new PromptAsks(
      port,
      async () => read,
      () => undefined,
    );

    await asks.sweep(rosterOf(true));
    await asks.sweep(rosterOf(true));
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      source: 'prompt',
      kind: 'task',
      subject: 'Permission: Bash ls',
      ferret: 'f1',
      blocking: true,
      raisedBy: { kind: 'daemon' },
      ref: { kind: 'permission', prompt: permission.id },
      entry: promptEntry('f1', { kind: 'permission', prompt: permission.id }),
    });
    expect(closed).toEqual([]);

    read = { turnState: 'working' };
    await asks.sweep(rosterOf(true));
    expect(closed).toEqual([`f1 withdrawn ${raised[0]!.entry}`]);
  });

  test('a changed prompt is a new card and the old one is closed', async () => {
    const { port, raised, closed } = board();
    let id = permission.id;
    const asks = new PromptAsks(
      port,
      async () => parked(id),
      () => undefined,
    );

    await asks.sweep(rosterOf(true));
    id = 'aaaaaaaaaaaaaaaa';
    await asks.sweep(rosterOf(true));

    expect(raised).toHaveLength(2);
    expect(closed).toEqual([`f1 withdrawn ${raised[0]!.entry}`]);
  });

  test('has its card closed when the ferret stops or goes away, and a stopped ferret is never read', async () => {
    const { port, raised, closed } = board();
    const reads: string[] = [];
    const asks = new PromptAsks(
      port,
      async ferret => {
        reads.push(ferret);
        return parked();
      },
      () => undefined,
    );

    await asks.sweep(rosterOf(true, true));
    expect(raised.map(draft => draft.ferret)).toEqual(['f1', 'f2']);

    await asks.sweep(rosterOf(false, true));
    expect(closed).toEqual([`f1 withdrawn ${raised[0]!.entry}`]);

    await asks.sweep([]);
    expect(closed).toEqual([`f1 withdrawn ${raised[0]!.entry}`, `f2 withdrawn ${raised[1]!.entry}`]);
    expect(reads).toEqual(['f1', 'f2', 'f2']);
  });

  test('a card that cannot be raised is said once, asked again by the next look, and does not stop the other ferrets', async () => {
    const { port, raised } = board(true);
    const said: string[] = [];
    const asks = new PromptAsks(
      port,
      async ferret => {
        if (ferret === 'f1') throw new Error('pane unreadable');
        return parked();
      },
      message => said.push(message),
    );

    await asks.sweep(rosterOf(true, true));
    await asks.sweep(rosterOf(true, true));

    expect(raised).toEqual([]);
    expect(said).toHaveLength(2);
    expect(said[0]).toContain('f1');
    expect(said[0]).toContain('pane unreadable');
    expect(said[1]).toContain('f2');
  });

  test('says it again once it worked in between', async () => {
    const { port } = board();
    let broken = true;
    const said: string[] = [];
    const asks = new PromptAsks(
      port,
      async () => {
        if (broken) throw new Error('pane unreadable');
        return undefined;
      },
      message => said.push(message),
    );

    await asks.sweep(rosterOf(true));
    broken = false;
    await asks.sweep(rosterOf(true));
    broken = true;
    await asks.sweep(rosterOf(true));

    expect(said).toHaveLength(2);
  });
});
