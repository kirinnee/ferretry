import { describe, expect, test } from 'bun:test';
import type { Instant } from '@ferretry/std';
import type { FerretId, FerretRecord, FerretWaiting } from '../../../../../contract/index.ts';
import {
  FerretSignalArtifacts,
  FerretSignalRepository,
  FerretSignalTerminal,
  type FerretSignalHost,
} from '../../../../../daemon/adapters/session/signal/ferret-signal.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';

/**
 * The three signal adapters over a scripted Ferrets host: where a ferret's four states and the domain's status words
 * meet, what a transition records and in what order, and the evidence a signal leaves. Nothing starts a daemon or a pane.
 */

const ID = parseSessionId('ses-1');
const AT = '2026-11-06T09:00:00.000Z' as Instant;
const UNTIL = '2026-11-06T10:00:00.000Z' as Instant;

interface Script {
  record?: Partial<FerretRecord> | undefined;
  waiting?: FerretWaiting | undefined;
  credit?: number | undefined;
  resolved?: string | undefined;
}

const hostOf = (script: Script) => {
  const calls: string[] = [];
  const saved: { waiting: unknown; credit: unknown }[] = [];
  const history: { type: string; data: unknown }[] = [];
  const host: FerretSignalHost = {
    ready: async () => void calls.push('ready'),
    record: () =>
      script.record === undefined ? undefined : ({ name: 'wren', state: 'working', ...script.record } as FerretRecord),
    resolve: () => script.resolved as FerretId | undefined,
    waitingOf: () => script.waiting,
    creditOf: async () => script.credit,
    saveWaiting: async (_ferret, waiting, credit) => {
      calls.push('saveWaiting');
      saved.push({ waiting, credit });
    },
    saveFinished: async (_ferret, at) => void calls.push(`saveFinished ${at}`),
    writeSummary: async (_ferret, text) => void calls.push(`summary ${JSON.stringify(text)}`),
    history: async (_ferret, type, data) => {
      calls.push(`history ${type}`);
      history.push({ type, data });
    },
    stop: async (_ferret, reason) => void calls.push(`stop ${reason}`),
  };
  return { host, calls, saved, history };
};

describe('reading a ferret as a signal target', () => {
  test('is nothing for a ferret the registry does not hold', async () => {
    const { host, calls } = hostOf({ record: undefined });
    expect(await new FerretSignalRepository(host).read(ID)).toBeUndefined();
    expect(calls).toEqual(['ready']);
  });

  test('reads each ferret state in the status words the domain reasons in', async () => {
    const statusOf = async (script: Script) => (await new FerretSignalRepository(hostOf(script).host).read(ID))?.status;
    expect(await statusOf({ record: { state: 'stopped' }, waiting: { since: AT } })).toBe('stopped');
    expect(await statusOf({ record: { state: 'working' }, waiting: { since: AT } })).toBe('waiting');
    expect(await statusOf({ record: { state: 'starting' } })).toBe('starting');
    expect(await statusOf({ record: { state: 'idle' } })).toBe('awaiting_user');
    expect(await statusOf({ record: { state: 'working' } })).toBe('running');
  });

  test('carries the callsign, the mode, the declared wait and the credit it was given', async () => {
    const target = await new FerretSignalRepository(
      hostOf({
        record: { mode: 'auto', name: 'fern' },
        waiting: { since: AT, until: UNTIL, condition: 'review lands', peer: 'ses-2' as FerretId, peerName: 'ash' },
        credit: 90,
      }).host,
    ).read(ID);
    expect(target).toEqual({
      id: ID,
      status: 'waiting',
      mode: 'auto',
      turn: 0,
      teammate: 'fern',
      waiting: { since: AT, until: UNTIL, condition: 'review lands', peer: 'ses-2', peerName: 'ash' },
      waitingCreditSeconds: 90,
    });
  });

  test('says interactive for a ferret started in no mode, and carries no wait or credit when there are none', async () => {
    const target = await new FerretSignalRepository(hostOf({ record: { mode: 'interactive' } }).host).read(ID);
    expect(target).toEqual({ id: ID, status: 'running', mode: 'interactive', turn: 0, teammate: 'wren' });
    const bare = await new FerretSignalRepository(hostOf({ record: { mode: undefined } }).host).read(ID);
    expect(bare?.mode).toBe('interactive');
  });
});

describe('resolving the peer a wait names', () => {
  test('is nothing when no ferret answers to the reference or the answer is not a usable session id', async () => {
    expect(
      await new FerretSignalRepository(hostOf({ record: {}, resolved: undefined }).host).resolvePeer('nobody'),
    ).toBeUndefined();
    expect(
      await new FerretSignalRepository(hostOf({ record: {}, resolved: '../escape' }).host).resolvePeer('x'),
    ).toBeUndefined();
  });

  test('is the target of the ferret that answers', async () => {
    const target = await new FerretSignalRepository(
      hostOf({ record: { name: 'ash' }, resolved: 'ses-2' }).host,
    ).resolvePeer('ash');
    expect(target).toMatchObject({ id: 'ses-2', teammate: 'ash' });
  });
});

describe('recording a signal transition', () => {
  test('a declared wait is saved with the credit already held, then journalled, then read back', async () => {
    const { host, calls, saved, history } = hostOf({ record: {}, waiting: { since: AT }, credit: 30 });
    const target = await new FerretSignalRepository(host).transition(ID, {
      event: 'session.waiting',
      waiting: { since: AT, until: UNTIL },
      reason: 'waiting for review',
      data: { peer: 'ash' },
    });
    expect(saved).toEqual([{ waiting: { since: AT, until: UNTIL }, credit: 30 }]);
    expect(history).toEqual([{ type: 'session.waiting', data: { reason: 'waiting for review', peer: 'ash' } }]);
    expect(calls).toEqual(['saveWaiting', 'history session.waiting', 'ready']);
    expect(target.status).toBe('waiting');
  });

  test('a completion records when the ferret said done and journals the verdict', async () => {
    const { host, calls } = hostOf({ record: { state: 'stopped' } });
    await new FerretSignalRepository(host).transition(ID, { event: 'session.completed', finishedAt: AT });
    expect(calls).toEqual([`saveFinished ${AT}`, 'history session.completed', 'ready']);
  });

  test('a cleared wait saves no wait, with the credit the change carries or else the one already held', async () => {
    const carried = hostOf({ record: {}, credit: 10 });
    await new FerretSignalRepository(carried.host).transition(ID, {
      event: 'session.waiting_cleared',
      waitingCreditSeconds: 45,
    });
    expect(carried.saved).toEqual([{ waiting: undefined, credit: 45 }]);
    const held = hostOf({ record: {}, credit: 10 });
    await new FerretSignalRepository(held.host).transition(ID, { event: 'session.waiting_cleared' });
    expect(held.saved).toEqual([{ waiting: undefined, credit: 10 }]);
  });

  test('a held wait changes no record and writes no journal line', async () => {
    const { host, calls } = hostOf({ record: {} });
    await new FerretSignalRepository(host).transition(ID, { event: 'session.waiting_held' });
    expect(calls).toEqual(['ready']);
  });

  test('a help request is journalled with no record change, and a wait of "clear" on a waiting event saves nothing', async () => {
    const help = hostOf({ record: {} });
    await new FerretSignalRepository(help.host).transition(ID, { event: 'interaction.help', reason: 'stuck' });
    expect(help.history).toEqual([{ type: 'interaction.help', data: { reason: 'stuck' } }]);
    expect(help.saved).toEqual([]);
    const clearOnWaiting = hostOf({ record: {} });
    await new FerretSignalRepository(clearOnWaiting.host).transition(ID, {
      event: 'session.waiting',
      waiting: 'clear',
    });
    expect(clearOnWaiting.saved).toEqual([]);
  });

  test('raises when the ferret cannot be read back after the signal', async () => {
    const { host } = hostOf({ record: undefined });
    await expect(new FerretSignalRepository(host).transition(ID, { event: 'interaction.help' })).rejects.toThrow(
      'ferret ses-1 is unreadable after a signal',
    );
  });
});

describe('the evidence a signal leaves', () => {
  test('a summary is the trimmed words the ferret gave plus a newline, or the default when it gave none', async () => {
    const { host, calls } = hostOf({});
    const artifacts = new FerretSignalArtifacts(host);
    await artifacts.writeSummary(ID, '  all done  ');
    await artifacts.writeSummary(ID, '   ');
    await artifacts.writeSummary(ID, undefined);
    expect(calls).toEqual([
      'summary "all done\\n"',
      'summary "Task completed; inspect chat and repository diff.\\n"',
      'summary "Task completed; inspect chat and repository diff.\\n"',
    ]);
  });

  test('a done marker is nothing now that the stopped state is the verdict', async () => {
    const { host, calls } = hostOf({});
    await new FerretSignalArtifacts(host).markDone();
    expect(calls).toEqual([]);
  });

  test('a question is a history event the lead can read', async () => {
    const { host, history } = hostOf({});
    await new FerretSignalArtifacts(host).raiseQuestion(ID, 'which branch?');
    expect(history).toEqual([{ type: 'interaction.question', data: { message: 'which branch?' } }]);
  });
});

describe('the signal terminal', () => {
  test('keeps no final frame of its own and stops the ferret with the reason it was given', async () => {
    const { host, calls } = hostOf({});
    const terminal = new FerretSignalTerminal(host);
    await terminal.snapshot();
    await terminal.stop(ID, 'the ferret said done');
    expect(calls).toEqual(['stop the ferret said done']);
  });
});
