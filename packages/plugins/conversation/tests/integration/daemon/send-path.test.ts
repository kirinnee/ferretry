import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import type {
  FerretHarness,
  FerretId,
  FerretTurnDocument,
  FerretTurns,
  HarnessQueueOptions,
  RunnerDelivery,
  TranscriptEntry,
} from '@ferretry/core-ferrets/contract';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { StatePort } from '@ferretry/kernel/contract';
import { fixedClock, owner, testHost } from '@ferretry/kernel/testing';
import type { Instant } from '@ferretry/std';
import { err, ok } from '@ferretry/std';
import { CONVERSATION_STATE, ConversationPort } from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';
import { StateSendLedger } from '../../../daemon/delivery/adapters/index.ts';
import { queuedPayloadInstruction, turnInstruction } from '../../../daemon/delivery/lib/index.ts';
import { parseSessionId } from '../../../daemon/seams/ferret-id.ts';
import { memoryStatePort } from '../../support/state.ts';

/**
 * The #45 send path through the real daemon half: the turn document a send goes by (BG-051), the send tracker that
 * settles a send's fate only on proof (BG-052) and the queued file the ledger names (BG-053). Ferrets is the fake whose
 * harness records every key and whose turn documents are plain recorders; the clock is driven, so a deadline is a number
 * the test advances to. What Ferrets writes to disk (0600, numbering, markers) is proved in its own tests.
 */

const F1 = ferretId('f1');
const F2 = ferretId('f2');
const START = '2026-11-07T09:00:00Z';
const PROOF_AT = '2026-11-07T09:00:01.000Z' as Instant;

/** The pane a runner reads: free at a prompt, or busy at work. */
const IDLE_PANE = { alive: true, dead: false, promptReady: true, activeWork: false } as const;
const BUSY_PANE = { alive: true, dead: false, promptReady: false, activeWork: true } as const;

class SendFerrets extends FakeFerrets {
  /** Every text a key was sent for, in order: typed at the prompt. */
  readonly typed: string[] = [];
  /** Every text put into the harness's own queue. */
  readonly queued: { readonly text: string; readonly options: HarnessQueueOptions | undefined }[] = [];
  readonly documents: { readonly turn: number; readonly document: string }[] = [];
  readonly files: { readonly sendId: string; readonly payload: string }[] = [];
  markersCleared = 0;
  busy = false;
  /** What the harness plugin reads of the conversation. */
  transcript: TranscriptEntry[] = [];
  /** Whether Ferrets offers a writer at all, and whether a write fails. */
  writer: 'offered' | 'absent' | 'failing' = 'offered';
  queueFile: 'offered' | 'failing' = 'offered';
  stored: FerretTurnDocument[] = [];

  fileOf = (sendId: string): string => `/state/channel/queued-${sendId}.md`;
  turnFileOf = (turn: number): string => `/state/turns/turn-${String(turn).padStart(3, '0')}.md`;

  async harness(ferret: FerretId): Promise<FerretHarness | undefined> {
    if ((await this.get(ferret)) === undefined) return undefined;
    return {
      deliver: async (delivery: RunnerDelivery) => {
        if (this.busy) return err({ refused: 'not_ready' as const, why: 'busy' as const });
        this.typed.push(delivery.text);
        return ok('turn-started' as const);
      },
      queue: async (text, options) => {
        this.queued.push({ text, options });
        return ok('held' as const);
      },
      interrupt: async () => ok({ pressed: true, working: false }),
      observe: async () => ok(this.busy ? BUSY_PANE : IDLE_PANE),
      heldAt: async () => ok(undefined),
      transcript: {
        read: async () => this.transcript,
        follow: () => {
          throw new Error('unused');
        },
        find: async () => undefined,
      },
    };
  }

  async turns(ferret: FerretId): Promise<FerretTurns | undefined> {
    if ((await this.get(ferret)) === undefined) return undefined;
    const base: FerretTurns = { list: async () => this.stored };
    if (this.writer === 'absent') return base;
    return {
      ...base,
      write: async request => {
        if (this.writer === 'failing') throw new Error('FIXTURE_SECRET disk full');
        const turn = this.documents.length + 2;
        this.documents.push({ turn, document: request.document });
        this.stored.push({ turn, text: request.document.trimEnd() });
        return { turn, file: this.turnFileOf(turn) };
      },
      writeQueued: async (sendId, payload) => {
        if (this.queueFile === 'failing') throw new Error('FIXTURE_SECRET disk full');
        this.files.push({ sendId, payload });
        return this.fileOf(sendId);
      },
      clearMarkers: async () => {
        this.markersCleared += 1;
      },
    };
  }
}

const userEntry = (text: string, id = 'u-proof'): TranscriptEntry => ({ id, role: 'user', text, at: PROOF_AT });
const otherEntry: TranscriptEntry = { id: 'a-1', role: 'assistant', text: 'FIXTURE reply', at: PROOF_AT };

/** Lets everything a driven timer started run to its end (a look reads a transcript, a pane and a ledger). */
const settle = async (): Promise<void> => {
  for (let round = 0; round < 25; round += 1) await Bun.sleep(0);
};

async function conversation(
  setup: (ferrets: SendFerrets) => void = () => undefined,
  state: StatePort = memoryStatePort(CONVERSATION_STATE),
) {
  const ferrets = new SendFerrets();
  ferrets.add({ id: F1, state: 'idle' });
  ferrets.add({ id: F2, state: 'idle' });
  setup(ferrets);
  const clock = fixedClock(START);
  const built: { half?: ReturnType<NonNullable<typeof daemon.build>> } = {};
  const implementation = {
    ...daemon,
    build: (ctx: Parameters<NonNullable<typeof daemon.build>>[0]) => {
      const build = daemon.build;
      if (build === undefined) throw new Error('the conversation daemon half has no build');
      const half = build({ ...ctx, kernel: { ...ctx.kernel, state } });
      built.half = half;
      return half;
    },
  } as typeof daemon;
  const host = await testHost({ plugins: [implementation], fakes: { ferrets, asks: new FakeAsks() }, clock });
  await settle();
  const api = () => host.provided(ConversationPort);
  const row = async (sendId: string) => (await api().sends(F1)).sends.find(entry => entry.sendId === sendId);
  /**
   * The row as the ledger holds it, read WITHOUT asking the tracker for a look (a read through the API does ask for one).
   * A test about what a timer settles reads here, so only the tracker's own looks can have moved the fate.
   */
  const stored = async (sendId: string, id: string = 'f1') =>
    (await new StateSendLedger(state, { now: () => START as Instant }).list(parseSessionId(id))).find(
      entry => entry.sendId === sendId,
    );
  /** Moves the driven clock in steps and lets each step's looks finish: a tracker look schedules the next one. */
  const advance = async (totalMs: number, stepMs = 1_000): Promise<void> => {
    for (let spent = 0; spent < totalMs; spent += stepMs) {
      await clock.advance(stepMs);
      await settle();
    }
  };
  return { host, ferrets, api, state, clock, built, row, stored, advance };
}

const long = (length: number): string => 'x'.repeat(length);

describe('BG-051 a direct send that today goes as a turn file writes the file and types its pointer', () => {
  test('BG-051 a 600-character send to a non-interactive ferret writes one turn document and types only the pointer', async () => {
    const { host, ferrets, api, row } = await conversation();
    const message = long(600);

    const sent = await api().send(F1, { kind: 'owner' }, { message, sendId: 's-600' });

    expect(sent).toMatchObject({ ok: true, value: { disposition: 'sent', fate: 'accepted' } });
    expect(ferrets.documents).toEqual([{ turn: 2, document: `${message}\n` }]);
    expect(ferrets.typed).toEqual([turnInstruction(ferrets.turnFileOf(2))]);
    expect(JSON.stringify(ferrets.typed)).not.toContain('xxxx');
    // The row names what the transcript will hold (the pointer), the words the owner sent, and the turn it started.
    expect(await row('s-600')).toMatchObject({ path: 'turn-file', message, turn: 2 });
    // The prompt landed: the markers the turn that just ended left are cleared.
    expect(ferrets.markersCleared).toBe(1);
    await host.stop();
  });

  test('BG-051 the 500/501 boundary for a non-interactive ferret: 500 characters are typed in full, 501 go by file', async () => {
    const { host, ferrets, api } = await conversation();

    await api().send(F1, { kind: 'owner' }, { message: long(500), sendId: 's-500' });
    await api().send(F1, { kind: 'owner' }, { message: long(501), sendId: 's-501' });

    expect(ferrets.typed).toEqual([long(500), turnInstruction(ferrets.turnFileOf(3))]);
    // Both are written (today's `deliver` writes the document on both transports).
    expect(ferrets.documents.map(entry => entry.turn)).toEqual([2, 3]);
    await host.stop();
  });

  test('BG-051 an interactive Claude ferret still gets a multi-line paste inline, under 2000 characters', async () => {
    const { host, ferrets, api, row } = await conversation(f => f.add({ id: F1, state: 'idle', mode: 'interactive' }));
    const message = `${long(700)}\n${long(700)}`;

    await api().send(F1, { kind: 'owner' }, { message, sendId: 's-paste' });

    expect(ferrets.typed).toEqual([message]);
    expect(await row('s-paste')).toMatchObject({ path: 'direct', turn: 2 });
    await host.stop();
  });

  test('BG-051 an interactive Claude ferret over 2000 characters goes by file', async () => {
    const { host, ferrets, api } = await conversation(f => f.add({ id: F1, state: 'idle', mode: 'interactive' }));

    await api().send(F1, { kind: 'owner' }, { message: `${long(1_100)}\n${long(1_100)}`, sendId: 's-over' });

    expect(ferrets.typed).toEqual([turnInstruction(ferrets.turnFileOf(2))]);
    await host.stop();
  });

  test('BG-051 every peer send to Codex goes by file, because the banner makes it more than one line', async () => {
    const { host, ferrets, api, row } = await conversation(f => f.add({ id: F1, state: 'idle', harness: 'codex' }));

    await api().send(F1, { kind: 'ferret', ferret: F2 }, { message: 'FIXTURE short', sendId: 's-peer' });

    expect(ferrets.documents).toHaveLength(1);
    expect(ferrets.documents[0]?.document).toContain('FIXTURE short');
    expect(ferrets.typed).toEqual([turnInstruction(ferrets.turnFileOf(2))]);
    expect(await row('s-peer')).toMatchObject({ path: 'turn-file', senderKind: 'agent', from: F2 });
    await host.stop();
  });

  test('BG-051 a send the owner’s words count once: the row accounts for its own turn document', async () => {
    const { host, api } = await conversation();
    const message = long(600);

    await api().send(F1, { kind: 'owner' }, { message, sendId: 's-words' });

    const words = await api().ownerWords(F1);
    expect(words).toMatchObject({ ok: true });
    expect(words.ok ? words.value.words : []).toEqual([message]);
    await host.stop();
  });

  test('BG-051 a pane at work is the queue’s: no turn is started, so no turn document is written', async () => {
    const { host, ferrets, api, row } = await conversation(f => {
      f.busy = true;
    });

    const sent = await api().send(F1, { kind: 'owner' }, { message: long(600), sendId: 's-busy' });

    expect(sent).toMatchObject({ ok: true, value: { disposition: 'queued', fate: 'queued' } });
    expect(ferrets.documents).toEqual([]);
    expect(ferrets.typed).toEqual([]);
    expect(ferrets.queued.map(entry => entry.text)).toEqual([long(600)]);
    expect(await row('s-busy')).toMatchObject({ path: 'native-inline', fate: 'queued' });
    expect(ferrets.markersCleared).toBe(0);
    await host.stop();
  });

  test('BG-051 a turn document that cannot be written types nothing and keeps no row, without quoting why', async () => {
    const { host, ferrets, api } = await conversation(f => {
      f.writer = 'failing';
    });

    const sent = await api().send(F1, { kind: 'owner' }, { message: long(600), sendId: 's-fails' });

    expect(sent.ok).toBe(false);
    expect(JSON.stringify(sent)).not.toContain('FIXTURE_SECRET');
    expect(ferrets.typed).toEqual([]);
    expect((await api().sends(F1)).sends).toEqual([]);
    await host.stop();
  });

  test('BG-051 a Ferrets with no writer types the message as it is (nothing to point at)', async () => {
    const { host, ferrets, api } = await conversation(f => {
      f.writer = 'absent';
    });

    await api().send(F1, { kind: 'owner' }, { message: long(600), sendId: 's-bare' });

    expect(ferrets.typed).toEqual([long(600)]);
    expect(ferrets.documents).toEqual([]);
    expect(ferrets.markersCleared).toBe(0);
    await host.stop();
  });
});

describe('BG-053 a send queued by file is ledgered native-file, with the pointer and the path', () => {
  test('BG-053 a message over 1000 characters to a busy pane is written first, ledgered native-file and queued as its pointer', async () => {
    const { host, ferrets, api, row } = await conversation(f => {
      f.busy = true;
    });
    const message = long(1_500);

    const sent = await api().send(F1, { kind: 'owner' }, { message, sendId: 'send-q-1' });

    expect(sent).toMatchObject({ ok: true, value: { disposition: 'queued', fate: 'queued' } });
    const file = ferrets.fileOf('send-q-1');
    expect(ferrets.files).toEqual([{ sendId: 'send-q-1', payload: message }]);
    // Ferrets' queue is handed the one-line pointer, which it never turns into a file of its own.
    expect(ferrets.queued.map(entry => entry.text)).toEqual([queuedPayloadInstruction(file)]);
    const settled = await row('send-q-1');
    expect(settled).toMatchObject({ path: 'native-file', fate: 'queued', queueProof: 'pane' });
    // The wire row keeps the pointer and the path private (a client reads the words from the hand-off), as ever.
    expect(JSON.stringify(settled)).not.toContain(file);
    await host.stop();
  });

  test('BG-053 the ledger holds what the pane holds: matchText is the pointer and payloadFile is the path', async () => {
    const { host, ferrets, api, state } = await conversation(f => {
      f.busy = true;
    });

    await api().send(F1, { kind: 'owner' }, { message: long(1_500), sendId: 'send-q-2' });

    const [stored] = await new StateSendLedger(state, { now: () => START as Instant }).list(parseSessionId('f1'));
    expect(stored).toMatchObject({
      path: 'native-file',
      matchText: queuedPayloadInstruction(ferrets.fileOf('send-q-2')),
      payloadFile: ferrets.fileOf('send-q-2'),
      message: long(1_500),
    });
    await host.stop();
  });

  test('BG-053 1000 characters are queued inline and 1001 by file', async () => {
    const { host, ferrets, api, row } = await conversation(f => {
      f.busy = true;
    });

    await api().send(F1, { kind: 'owner' }, { message: long(1_000), sendId: 'send-at' });
    await api().send(F1, { kind: 'owner' }, { message: long(1_001), sendId: 'send-over' });

    expect(ferrets.queued.map(entry => entry.text)).toEqual([
      long(1_000),
      queuedPayloadInstruction(ferrets.fileOf('send-over')),
    ]);
    expect((await row('send-at'))?.path).toBe('native-inline');
    expect((await row('send-over'))?.path).toBe('native-file');
    await host.stop();
  });

  test('BG-053 a file that cannot be written types nothing: the busy refusal stands and the id may start over', async () => {
    const { host, ferrets, api } = await conversation(f => {
      f.busy = true;
      f.queueFile = 'failing';
    });

    const sent = await api().send(F1, { kind: 'owner' }, { message: long(1_500), sendId: 'send-q-3' });

    expect(sent.ok).toBe(false);
    expect(JSON.stringify(sent)).not.toContain('FIXTURE_SECRET');
    expect(ferrets.queued).toEqual([]);
    // The row was taken back (nothing was typed), so the same id starts over and goes by file once the disk allows.
    expect((await api().sends(F1)).sends).toMatchObject([{ sendId: 'send-q-3', withdrawn: true }]);
    ferrets.queueFile = 'offered';
    const again = await api().send(F1, { kind: 'owner' }, { message: long(1_500), sendId: 'send-q-3' });
    expect(again).toMatchObject({ ok: true, value: { disposition: 'queued', fate: 'queued' } });
    expect(ferrets.queued.map(entry => entry.text)).toEqual([queuedPayloadInstruction(ferrets.fileOf('send-q-3'))]);
    await host.stop();
  });

  test('BG-053 a Ferrets with no queued-file writer leaves the file to its own queue, ledgered inline as before', async () => {
    const { host, ferrets, api, row } = await conversation(f => {
      f.busy = true;
      f.writer = 'absent';
    });

    await api().send(F1, { kind: 'owner' }, { message: long(1_500), sendId: 'send-q-4' });

    expect(ferrets.queued).toEqual([{ text: long(1_500), options: { sendId: 'send-q-4' } }]);
    expect((await row('send-q-4'))?.path).toBe('native-inline');
    await host.stop();
  });

  test('BG-053 a pointer queued after the pane turned busy mid-send re-names the row: native-inline for a short message', async () => {
    // The look saw a free pane and wrote the turn document; the delivery then met a busy one.
    const { host, ferrets, api, row } = await conversation();
    const real = ferrets.harness.bind(ferrets);
    ferrets.harness = async ferret => {
      const harness = await real(ferret);
      return harness === undefined
        ? undefined
        : {
            ...harness,
            deliver: async () => err({ refused: 'not_ready' as const, why: 'busy' as const }),
          };
    };

    await api().send(F1, { kind: 'owner' }, { message: long(600), sendId: 'send-race' });

    expect(ferrets.documents).toHaveLength(1);
    expect(ferrets.queued.map(entry => entry.text)).toEqual([long(600)]);
    expect(await row('send-race')).toMatchObject({ path: 'native-inline', turn: 2 });
    await host.stop();
  });
});

describe('BG-052 only proof moves a fate', () => {
  test('BG-052 a delivered send settles delivered on the transcript’s proof', async () => {
    const { host, ferrets, api, stored, advance } = await conversation();
    await api().send(F1, { kind: 'owner' }, { message: 'FIXTURE hello', sendId: 's-ok' });
    expect((await stored('s-ok'))?.fate).toBe('accepted');

    ferrets.transcript = [userEntry('FIXTURE hello')];
    await advance(3_000);

    expect(await stored('s-ok')).toMatchObject({ fate: 'delivered' });
    await host.stop();
  });

  test('BG-052 a send by file settles delivered on the pointer the transcript records', async () => {
    const { host, ferrets, api, stored, advance } = await conversation();
    await api().send(F1, { kind: 'owner' }, { message: long(600), sendId: 's-file-ok' });

    ferrets.transcript = [userEntry(turnInstruction(ferrets.turnFileOf(2)))];
    await advance(3_000);

    expect(await stored('s-file-ok')).toMatchObject({ fate: 'delivered', path: 'turn-file' });
    await host.stop();
  });

  test('BG-052 a never-proved send is typed again once, proven absent, and settles timed_out at its deadline', async () => {
    const { host, ferrets, api, stored, advance } = await conversation();
    ferrets.transcript = [otherEntry];
    await api().send(F1, { kind: 'owner' }, { message: 'FIXTURE lost', sendId: 's-lost' });
    expect(ferrets.typed).toEqual(['FIXTURE lost']);

    // Before its deadline (a person's send: one minute) nothing is claimed.
    await advance(30_000, 5_000);
    expect((await stored('s-lost'))?.fate).toBe('accepted');

    await advance(150_000, 5_000);

    expect(await stored('s-lost')).toMatchObject({ fate: 'timed_out', unaccountedReason: 'not_delivered' });
    // Proven absent from the transcript, the queue and the composer: typed again under the same id, bounded.
    expect(ferrets.typed.length).toBeGreaterThan(1);
    expect(ferrets.typed.every(text => text === 'FIXTURE lost')).toBe(true);
    await host.stop();
  });

  test('BG-052 a send the transcript cannot be read for is unconfirmed, never retyped', async () => {
    const { host, ferrets, api, stored, advance } = await conversation();
    ferrets.transcript = [];
    await api().send(F1, { kind: 'owner' }, { message: 'FIXTURE unread', sendId: 's-unread' });

    await advance(150_000, 5_000);

    expect(await stored('s-unread')).toMatchObject({ fate: 'unaccounted', unaccountedReason: 'transcript_unbound' });
    expect(ferrets.typed).toEqual(['FIXTURE unread']);
    await host.stop();
  });

  test('BG-052 a held send settles delivered when the transcript shows the agent took it at the turn’s end', async () => {
    const { host, ferrets, api, stored, advance } = await conversation(f => {
      f.busy = true;
    });
    await api().send(F1, { kind: 'owner' }, { message: 'FIXTURE queued words', sendId: 's-held' });
    expect((await stored('s-held'))?.fate).toBe('queued');

    ferrets.transcript = [userEntry('FIXTURE queued words')];
    await advance(3_000);

    expect((await stored('s-held'))?.fate).toBe('delivered');
    await host.stop();
  });

  test('BG-052 a queue left outcome stays accepted until the transcript proves it', async () => {
    const { host, ferrets, api, stored, advance } = await conversation(f => {
      f.busy = true;
    });
    const real = ferrets.harness.bind(ferrets);
    ferrets.harness = async ferret => {
      const harness = await real(ferret);
      return harness === undefined ? undefined : { ...harness, queue: async () => ok('left' as const) };
    };
    await api().send(F1, { kind: 'owner' }, { message: 'FIXTURE left words', sendId: 's-left' });
    expect((await stored('s-left'))?.fate).toBe('accepted');

    ferrets.transcript = [userEntry('FIXTURE left words')];
    await advance(3_000);

    expect((await stored('s-left'))?.fate).toBe('delivered');
    await host.stop();
  });

  test('BG-052 a queued-by-file row is proved delivered by the pointer the harness records', async () => {
    const { host, ferrets, api, stored, advance } = await conversation(f => {
      f.busy = true;
    });
    await api().send(F1, { kind: 'owner' }, { message: long(1_500), sendId: 'send-q-9' });

    ferrets.transcript = [userEntry(queuedPayloadInstruction(ferrets.fileOf('send-q-9')))];
    await advance(3_000);

    expect(await stored('send-q-9')).toMatchObject({ fate: 'delivered', path: 'native-file' });
    await host.stop();
  });

  test('BG-052 a queued-by-file row is NOT proved by the full text: the pane held the pointer', async () => {
    const { host, ferrets, api, stored, advance } = await conversation(f => {
      f.busy = true;
    });
    await api().send(F1, { kind: 'owner' }, { message: long(1_500), sendId: 'send-q-10' });

    ferrets.transcript = [userEntry(long(1_500))];
    await advance(3_000);

    expect((await stored('send-q-10'))?.fate).not.toBe('delivered');
    await host.stop();
  });

  test('BG-052 a daemon that restarted with a send in flight re-derives it from the transcript at boot', async () => {
    const first = await conversation();
    await first.api().send(F1, { kind: 'owner' }, { message: 'FIXTURE across restart', sendId: 's-restart' });
    await first.host.stop();

    const second = await conversation(f => {
      f.transcript = [userEntry('FIXTURE across restart')];
    }, first.state);
    await second.advance(1_000);

    expect((await second.stored('s-restart'))?.fate).toBe('delivered');
    await second.host.stop();
  });

  test('BG-052 a turn boundary asks for a look at a ferret with sends open, without waiting for a deadline', async () => {
    const { host, ferrets, api, stored, built } = await conversation(f => {
      f.busy = true;
    });
    await api().send(F1, { kind: 'owner' }, { message: 'FIXTURE boundary', sendId: 's-boundary' });
    ferrets.transcript = [userEntry('FIXTURE boundary')];

    built.half?.hooks['ferret.changed']?.({ ferret: F1, state: 'idle', previous: 'working', change: 'state' });
    await settle();

    expect((await stored('s-boundary'))?.fate).toBe('delivered');
    // A ferret going to work is no boundary: nothing is looked at.
    await host.stop();
  });

  test('BG-052 reading a send’s row asks for a bounded look first', async () => {
    const { host, ferrets, api, row } = await conversation();
    await api().send(F1, { kind: 'owner' }, { message: 'FIXTURE read', sendId: 's-read' });
    ferrets.transcript = [userEntry('FIXTURE read')];

    // No deadline has passed and no timer has run: the read itself is the look that proves it.
    expect((await api().sendRecord(F1, 's-read'))?.fate).toBeDefined();
    await settle();
    expect((await row('s-read'))?.fate).toBe('delivered');
    await host.stop();
  });
});

describe('BG-052 / BG-053 what a look cannot prove, it does not claim', () => {
  test('BG-053 a queued-by-file send left typed in the composer is unconfirmed on the native-file path, never typed again', async () => {
    const { host, ferrets, api, row, state } = await conversation(f => {
      f.busy = true;
    });
    const real = ferrets.harness.bind(ferrets);
    ferrets.harness = async ferret => {
      const harness = await real(ferret);
      // The pointer stays in the composer, and the pane shows it there (a tracker look that did not see it would clear the mark).
      return harness === undefined
        ? undefined
        : { ...harness, queue: async () => ok('typed' as const), heldAt: async () => ok('composer' as const) };
    };

    const sent = await api().send(F1, { kind: 'owner' }, { message: long(1_500), sendId: 'send-q-stuck' });

    expect(sent).toMatchObject({ ok: false, error: { code: 'send_unconfirmed' } });
    expect(await row('send-q-stuck')).toMatchObject({
      fate: 'unaccounted',
      unaccountedReason: 'landing_unconfirmed',
      path: 'native-file',
    });
    // The stranded-pointer guard reads the ledger's own fields: the pointer is typed and not sent, and names the file.
    const [stored] = await new StateSendLedger(state, { now: () => START as Instant }).list(parseSessionId('f1'));
    expect(stored).toMatchObject({
      typedNotSent: true,
      payloadFile: ferrets.fileOf('send-q-stuck'),
      matchText: queuedPayloadInstruction(ferrets.fileOf('send-q-stuck')),
    });
    await host.stop();
  });

  test('BG-052 a ferret the harness no longer knows leaves the transcript unreadable: unconfirmed, never retyped', async () => {
    const { host, ferrets, api, stored, advance } = await conversation();
    await api().send(F1, { kind: 'owner' }, { message: 'FIXTURE gone', sendId: 's-gone' });
    ferrets.harness = async () => undefined;

    await advance(150_000, 5_000);

    expect(await stored('s-gone')).toMatchObject({ fate: 'unaccounted' });
    expect(ferrets.typed).toEqual(['FIXTURE gone']);
    await host.stop();
  });

  test('BG-052 a peer send that is never proved settles timed_out, and the sender’s notice is logged by id', async () => {
    const { host, ferrets, api, stored, advance } = await conversation();
    ferrets.transcript = [otherEntry];
    await api().send(F1, { kind: 'ferret', ferret: F2 }, { message: 'FIXTURE peer lost', sendId: 's-peer-lost' });

    await advance(200_000, 5_000);

    expect(await stored('s-peer-lost')).toMatchObject({ fate: 'timed_out', senderKind: 'agent' });
    await host.stop();
  });
});

describe('BG-052 fy send --wait returns when the fate settles', () => {
  const status = (host: Awaited<ReturnType<typeof conversation>>['host'], sendId: string, query = 'waitMs=30000') =>
    host.request('GET', `/v1/ferrets/f1/sends/${sendId}`, {
      as: owner(),
      query: Object.fromEntries(new URLSearchParams(query)),
    });

  test('BG-052 a status read with waitMs is held open, and answers the moment the send is proved delivered', async () => {
    const { host, ferrets, api, advance } = await conversation();
    await api().send(F1, { kind: 'owner' }, { message: 'FIXTURE wait', sendId: 's-wait' });

    let answered: Awaited<ReturnType<typeof status>> | undefined;
    const waiting = status(host, 's-wait').then(response => (answered = response));
    await settle();
    expect(answered).toBeUndefined();
    ferrets.transcript = [userEntry('FIXTURE wait')];
    await advance(4_000);
    await waiting;

    expect(answered?.status).toBe(200);
    expect(answered?.json()).toMatchObject({ sendId: 's-wait', fate: 'delivered' });
    await host.stop();
  });

  test('BG-052 a send already settled is answered at once, and a read without waitMs is never held', async () => {
    const { host, ferrets, api, advance } = await conversation();
    await api().send(F1, { kind: 'owner' }, { message: 'FIXTURE done', sendId: 's-done' });
    ferrets.transcript = [userEntry('FIXTURE done')];
    await advance(3_000);

    expect((await status(host, 's-done')).json()).toMatchObject({ fate: 'delivered' });
    await api().send(F1, { kind: 'owner' }, { message: 'FIXTURE open', sendId: 's-open' });
    expect((await status(host, 's-open', '')).json()).toMatchObject({ sendId: 's-open', fate: 'accepted' });
    await host.stop();
  });

  test('BG-052 a wait ends at its bound with the row as it stands, and a send with no row is not found', async () => {
    const { host, ferrets, api, advance } = await conversation();
    ferrets.transcript = [otherEntry];
    await api().send(F1, { kind: 'owner' }, { message: 'FIXTURE slow', sendId: 's-slow' });

    const waiting = status(host, 's-slow', 'waitMs=3000');
    await advance(4_000);
    expect((await waiting).json()).toMatchObject({ sendId: 's-slow', fate: 'accepted' });

    const missing = status(host, 's-none', 'waitMs=2000');
    await advance(3_000);
    expect((await missing).status).toBe(404);
    await host.stop();
  });

  test('BG-052 one waiter per caller and send: a second read ends the first, which answers the row as it stands', async () => {
    const { host, ferrets, api, advance } = await conversation();
    ferrets.transcript = [otherEntry];
    await api().send(F1, { kind: 'owner' }, { message: 'FIXTURE twice', sendId: 's-twice' });

    const first = status(host, 's-twice');
    await settle();
    const second = status(host, 's-twice');
    await settle();

    expect((await first).json()).toMatchObject({ sendId: 's-twice', fate: 'accepted' });
    ferrets.transcript = [userEntry('FIXTURE twice')];
    await advance(4_000);
    expect((await second).json()).toMatchObject({ fate: 'delivered' });
    await host.stop();
  });

  test('BG-052 a waiter ends when the daemon stops', async () => {
    const { host, ferrets, api } = await conversation();
    ferrets.transcript = [otherEntry];
    await api().send(F1, { kind: 'owner' }, { message: 'FIXTURE stop', sendId: 's-stop' });

    const waiting = status(host, 's-stop');
    await settle();
    await host.stop();

    expect((await waiting).json()).toMatchObject({ sendId: 's-stop', fate: 'accepted' });
  });

  test('BG-052 waitMs is a whole number from 1 to 30000, and no other parameter is accepted', async () => {
    const { host, api } = await conversation();
    await api().send(F1, { kind: 'owner' }, { message: 'FIXTURE bad', sendId: 's-bad' });

    for (const query of ['waitMs=0', 'waitMs=30001', 'waitMs=abc', 'waitMs=1.5', 'wait=5'])
      expect((await status(host, 's-bad', query)).status).toBe(400);
    await host.stop();
  });
});
