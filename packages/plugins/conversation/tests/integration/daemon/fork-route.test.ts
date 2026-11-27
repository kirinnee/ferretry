import { afterEach, describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import type {
  FerretId,
  ForkFailure,
  ForkOptions,
  ForkedFerret,
  HarnessTranscriptBytes,
  LaunchOrigin,
  TurnRef,
} from '@ferretry/core-ferrets/contract';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { FULL_DEVICE_GRANTS, LIMITED_DEVICE_GRANTS } from '@ferretry/core-gate/contract';
import { FakeMailbox } from '@ferretry/core-mailbox/contract/testing';
import { device, fixedClock, owner, type TestHost, testHost } from '@ferretry/kernel/testing';
import { err, ok, type Result } from '@ferretry/std';
import { CONVERSATION_STATE, type ForkResult, type TranscriptPage } from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';
import { GovernedAdmission } from '../../support/governed-admission.ts';
import { memoryStatePort } from '../../support/state.ts';

/**
 * `POST /v1/ferrets/:ferretId/fork` through the real host: Gate's admission (the stand-in), Conversation's whole daemon half
 * (its reader, its message tokens, its attachment store) over a Ferrets fake. The fake is what a harness and Ferrets' fork
 * slice are: it holds each ferret's transcript as bytes, and its `forks.fork` cuts the source at the turn the route names
 * into a NEW ferret's transcript, as `Harness.fork` and `ForkService` do. The route, the selection proof and the
 * attachment copy are the code under test.
 */

const SOURCE = ferretId('f1');
const OWNER = { as: owner() } as const;
const stamp = (n: number): string => new Date(Date.UTC(2026, 1, 1) + n * 1_000).toISOString();

const user = (n: number, text: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'user',
    uuid: `u-${String(n)}`,
    timestamp: stamp(n),
    sessionId: 's1',
    message: { role: 'user', content: text },
    ...extra,
  });
const assistant = (n: number, text: string): string =>
  JSON.stringify({
    type: 'assistant',
    uuid: `a-${String(n)}`,
    timestamp: stamp(n),
    sessionId: 's1',
    message: { id: `m-${String(n)}`, role: 'assistant', content: [{ type: 'text', text }] },
  });

/** Three turns, each a person's words and an answer. */
const THREE_TURNS = [
  user(1, 'first question'),
  assistant(2, 'first answer'),
  user(3, 'second question'),
  assistant(4, 'second answer'),
  user(5, 'third question'),
  assistant(6, 'third answer'),
];

/** A turn starts at a person's words, not at one the harness wrote into the user channel (`isMeta`). */
const startsTurn = (line: string): boolean => {
  const record = JSON.parse(line) as { type: string; isMeta?: boolean };
  return record.type === 'user' && record.isMeta !== true;
};

const bytesOf = (lines: readonly string[]): Uint8Array => new TextEncoder().encode(`${lines.join('\n')}\n`);

/** One ferret's transcript file: replaceable, so a test can rewrite the conversation under a selection. */
class Disk {
  #lines: readonly string[];
  #generation = 0;
  constructor(lines: readonly string[]) {
    this.#lines = lines;
  }
  get lines(): readonly string[] {
    return this.#lines;
  }
  put(lines: readonly string[]): void {
    this.#generation += 1;
    this.#lines = lines;
  }
  readonly open = async (): Promise<HarnessTranscriptBytes> => {
    const generation = this.#generation;
    const bytes = bytesOf(this.#lines);
    const still = (): boolean => this.#generation === generation;
    return {
      format: 'claude',
      file: `file-${String(generation)}`,
      size: bytes.byteLength,
      mtimeMs: 1,
      read: async (offset, length) => bytes.slice(offset, offset + length),
      stat: async () => (still() ? { size: bytes.byteLength, mtimeMs: 1 } : undefined),
      close: async () => undefined,
    };
  };
}

interface ForkCall {
  readonly from: FerretId;
  readonly at: TurnRef;
  readonly options: ForkOptions;
  readonly caller: LaunchOrigin;
}

interface World {
  readonly host: TestHost;
  readonly gate: GovernedAdmission;
  readonly disks: Map<string, Disk>;
  readonly calls: ForkCall[];
  /** Set to make the next fork refuse as Ferrets' fork does, in its own words. */
  refuse: ForkFailure | undefined;
}

const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

async function world(
  options: { readonly lines?: readonly string[]; readonly withForks?: boolean } = {},
): Promise<World> {
  const gate = new GovernedAdmission();
  const disks = new Map<string, Disk>([[SOURCE, new Disk(options.lines ?? THREE_TURNS)]]);
  const calls: ForkCall[] = [];
  const state: { refuse: ForkFailure | undefined } = { refuse: undefined };
  const fake = new FakeFerrets();
  fake.add({ id: SOURCE, name: 'olive' });
  const ferrets = Object.assign(fake, {
    harness: async (id: FerretId) => ({ transcriptBytes: async () => await disks.get(id)?.open() }) as never,
    ...(options.withForks === false
      ? {}
      : {
          forks: {
            fork: async (
              from: FerretId,
              at: TurnRef,
              forkOptions: ForkOptions,
              caller: LaunchOrigin,
            ): Promise<Result<ForkedFerret, ForkFailure>> => {
              calls.push({ from, at, options: forkOptions, caller });
              if (state.refuse !== undefined) return err(state.refuse);
              const lines = disks.get(from)?.lines ?? [];
              const starts = lines.flatMap((line, index) => (startsTurn(line) ? [index] : []));
              const kept = lines.slice(0, starts[at.turn] ?? lines.length);
              const fresh = ferretId(`f${String(disks.size + 1)}`);
              disks.set(fresh, new Disk(kept));
              fake.add({ id: fresh, name: forkOptions.name ?? `fork-${fresh}` });
              return ok({
                ferret: fresh,
                harnessConversation: `conversation-${fresh}`,
                folder: '/work/project',
                ...(forkOptions.worktree === 'new'
                  ? { worktree: { path: '/work/worktrees/fork-olive', branch: 'fork/olive-01234567' } }
                  : {}),
              });
            },
          },
        }),
  });
  const conversation = {
    ...daemon,
    build: (ctx: Parameters<NonNullable<typeof daemon.build>>[0]) => {
      const build = daemon.build;
      if (build === undefined) throw new Error('the conversation daemon half has no build');
      return build({ ...ctx, kernel: { ...ctx.kernel, state: memoryStatePort(CONVERSATION_STATE) } });
    },
  } as typeof daemon;
  const host = await testHost({
    plugins: [conversation],
    fakes: { mailbox: new FakeMailbox(), ferrets, asks: new FakeAsks() },
    clock: fixedClock('2026-11-07T09:00:00Z'),
    gate,
  });
  hosts.push(host);
  return {
    host,
    gate,
    disks,
    calls,
    get refuse() {
      return state.refuse;
    },
    set refuse(value: ForkFailure | undefined) {
      state.refuse = value;
    },
  };
}

/** The rows the chat reads, each with the point and binding to hand back. */
async function rows(w: World, ferret: string = SOURCE): Promise<TranscriptPage['messages']> {
  const page = await w.host.request('GET', `/v1/ferrets/${ferret}/messages`, { query: { tail: '1' }, ...OWNER });
  expect(page.status).toBe(200);
  return page.json<TranscriptPage>().messages;
}

const textsOf = (messages: TranscriptPage['messages']): readonly string[] => messages.map(message => message.text);

const fork = async (w: World, body: Record<string, unknown>, as: object = OWNER) =>
  await w.host.request('POST', `/v1/ferrets/${SOURCE}/fork`, { body, ...as });

const upload = async (w: World, filename: string, text: string): Promise<string> => {
  const made = await w.host.request('POST', `/v1/ferrets/${SOURCE}/attachments`, {
    body: { filename, mime: 'text/plain', base64: Buffer.from(text).toString('base64') },
    ...OWNER,
  });
  expect(made.status).toBe(201);
  return made.json<{ id: string }>().id;
};

describe('POST /v1/ferrets/:ferretId/fork', () => {
  test('a fork at the latest turn makes a new ferret whose transcript is the source prefix and whose attachments open', async () => {
    const w = await world();
    const id = await upload(w, 'notes.txt', 'carried attachment bytes');
    const source = await rows(w);
    const latest = [...source].reverse().find(message => message.role === 'user');
    if (latest === undefined) throw new Error('the fixture has a user row');

    const response = await fork(w, { point: latest.point, selectionBinding: latest.selectionBinding });

    expect(response.status).toBe(201);
    const made = response.json<ForkResult>();
    expect(made.attachments).toBe(1);
    expect(made.notice).toBeUndefined();
    // Ferrets was asked for the third turn, as a person, in the source's own folder.
    expect(w.calls).toEqual([
      { from: SOURCE, at: { turn: 3 }, options: { worktree: 'same' }, caller: { kind: 'person' } },
    ]);
    // The new ferret's conversation, read through Conversation's own reader, is the source's.
    expect(textsOf(await rows(w, made.ferret))).toEqual(textsOf(source));
    // And its attachment opens, byte for byte.
    const opened = await w.host.request('GET', `/v1/ferrets/${made.ferret}/attachments/${id}`, OWNER);
    expect(opened.status).toBe(200);
    expect(Buffer.from(opened.json<{ base64: string }>().base64, 'base64').toString()).toBe('carried attachment bytes');
  });

  test('a message on an earlier turn cuts at the end of that turn, and an answer belongs to its own turn', async () => {
    const w = await world();
    const source = await rows(w);
    const answer = source.find(message => message.text === 'second answer');
    if (answer === undefined) throw new Error('the fixture has the second answer');

    const response = await fork(w, { point: answer.point, selectionBinding: answer.selectionBinding });

    expect(response.status).toBe(201);
    expect(w.calls.map(call => call.at)).toEqual([{ turn: 2 }]);
    expect(textsOf(await rows(w, response.json<ForkResult>().ferret))).toEqual([
      'first question',
      'first answer',
      'second question',
      'second answer',
    ]);
  });

  test('a record the harness wrote into the user channel is not a turn', async () => {
    const w = await world({
      lines: [
        user(1, 'first question'),
        assistant(2, 'first answer'),
        user(3, 'the harness says a job finished', { isMeta: true }),
        assistant(4, 'noted'),
      ],
    });
    const source = await rows(w);
    const noted = source.find(message => message.text === 'noted');
    if (noted === undefined) throw new Error('the fixture has the last answer');

    const response = await fork(w, { point: noted.point, selectionBinding: noted.selectionBinding });

    expect(response.status).toBe(201);
    expect(w.calls.map(call => call.at)).toEqual([{ turn: 1 }]);
  });

  test('a message before anything the person said is not a turn, and nothing is started', async () => {
    const w = await world({ lines: [assistant(1, 'hello, I am ready'), user(2, 'hi'), assistant(3, 'hi!')] });
    const [first] = await rows(w);
    if (first === undefined) throw new Error('the fixture has a first row');

    const response = await fork(w, { point: first.point, selectionBinding: first.selectionBinding });

    expect(response.status).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('not_a_turn');
    expect(w.calls).toEqual([]);
  });

  test('a binding the daemon never issued is refused stale, with nothing cut, started or copied', async () => {
    const w = await world();
    await upload(w, 'notes.txt', 'bytes');
    const [first] = await rows(w);
    if (first === undefined) throw new Error('the fixture has a first row');
    const forged = `s2.${'A'.repeat(43)}`;

    const response = await fork(w, { point: first.point, selectionBinding: forged });

    expect(response.status).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('selection_stale');
    expect(w.calls).toEqual([]);
    expect([...w.disks.keys()]).toEqual([SOURCE]);
  });

  test('a conversation rewritten after the selection was read refuses stale: the same point holds other words', async () => {
    const w = await world();
    const source = await rows(w);
    const latest = [...source].reverse().find(message => message.role === 'user');
    if (latest === undefined) throw new Error('the fixture has a user row');
    // The harness rewrites the file: the same byte range now holds different words.
    w.disks.get(SOURCE)?.put(THREE_TURNS.map(line => line.replace('third question', 'third questiOn')));

    const response = await fork(w, { point: latest.point, selectionBinding: latest.selectionBinding });

    expect(response.status).toBe(409);
    expect(response.json<{ code: string; error: string }>().code).toBe('selection_stale');
    expect(response.json<{ error: string }>().error).toContain('Pick it again');
    expect(w.calls).toEqual([]);
  });

  test('a device holding fleet use only is refused 403 before the body is read, and nothing happens', async () => {
    const w = await world();
    w.gate.enrol('phone', { ...LIMITED_DEVICE_GRANTS, fleet: { use: true, configure: false } });
    const [first] = await rows(w);
    if (first === undefined) throw new Error('the fixture has a first row');

    const response = await fork(
      w,
      { point: first.point, selectionBinding: first.selectionBinding },
      { as: device('phone') },
    );

    expect(response.status).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('grant_device_not_granted');
    expect(w.calls).toEqual([]);
  });

  test('a device holding fleet configure is served', async () => {
    const w = await world();
    w.gate.enrol('tablet', FULL_DEVICE_GRANTS);
    const source = await rows(w);
    const latest = source.find(message => message.text === 'first question');
    if (latest === undefined) throw new Error('the fixture has the first question');

    const response = await fork(
      w,
      { point: latest.point, selectionBinding: latest.selectionBinding },
      { as: device('tablet') },
    );

    expect(response.status).toBe(201);
    expect(w.calls.map(call => call.at)).toEqual([{ turn: 1 }]);
  });

  test('the name and the worktree choice reach Ferrets, and the answer carries a branch and no folder or path', async () => {
    const w = await world();
    const [first] = await rows(w);
    if (first === undefined) throw new Error('the fixture has a first row');

    const response = await fork(w, {
      point: first.point,
      selectionBinding: first.selectionBinding,
      name: 'try-the-other-way',
      worktree: 'new',
    });

    expect(response.status).toBe(201);
    expect(w.calls.map(call => call.options)).toEqual([{ worktree: 'new', name: 'try-the-other-way' }]);
    const made = response.json<ForkResult>();
    expect(made.worktree).toEqual({ branch: 'fork/olive-01234567' });
    expect(response.body).not.toContain('/work/');
  });

  test('a name that is not a callsign is refused before anything is cut, in words', async () => {
    const w = await world();
    const [first] = await rows(w);
    if (first === undefined) throw new Error('the fixture has a first row');

    const response = await fork(w, {
      point: first.point,
      selectionBinding: first.selectionBinding,
      name: 'Try the other way',
    });

    expect(response.status).toBe(400);
    expect(response.json<{ error: string }>().error).toContain('A name starts with a letter');
    expect(w.calls).toEqual([]);
  });

  const REFUSALS: readonly (readonly [string, ForkFailure, number, string])[] = [
    [
      'a rollout format nobody tested',
      {
        code: 'cut',
        reason:
          'the conversation was written by Codex 0.99.0, a rollout format Ferretry has not tested, so it was not forked',
      },
      409,
      'fork_refused',
    ],
    [
      'a cut that would leave a subagent behind',
      {
        code: 'cut',
        reason:
          'the conversation could not be cut: this cut includes a subagent whose separate transcript cannot be copied safely; pick a cut before it',
      },
      409,
      'fork_refused',
    ],
    [
      'a cut inside a tool call',
      {
        code: 'cut',
        reason:
          'the conversation could not be cut: turn 2 ends inside a tool call; pick a later turn that includes its answer',
      },
      409,
      'fork_refused',
    ],
    [
      'a ferret that is working right now',
      {
        code: 'running',
        reason:
          'Quick Otter is working right now, so its conversation is still being written. Fork it when it is idle or stopped',
      },
      409,
      'fork_running',
    ],
    [
      'a harness that cannot fork',
      {
        code: 'unsupported',
        reason: 'the opencode harness cannot fork a conversation yet, so nothing was forked and nothing was written',
      },
      409,
      'fork_unsupported',
    ],
    [
      'a checkout that is not a Git worktree',
      { code: 'worktree', reason: '/work/project is not in a Git checkout, so the fork cannot work in a new worktree' },
      409,
      'fork_worktree',
    ],
  ];
  for (const [label, failure, status, code] of REFUSALS)
    test(`${label} reaches the person as its own sentence, not a generic error`, async () => {
      const w = await world();
      w.refuse = failure;
      const [first] = await rows(w);
      if (first === undefined) throw new Error('the fixture has a first row');

      const response = await fork(w, { point: first.point, selectionBinding: first.selectionBinding });

      expect(response.status).toBe(status);
      expect(response.json<{ code: string }>().code).toBe(code);
      expect(response.json<{ error: string }>().error).toBe(failure.reason);
    });

  test('a Ferrets that offers no fork answers 503, never a made-up success', async () => {
    const w = await world({ withForks: false });
    const [first] = await rows(w);
    if (first === undefined) throw new Error('the fixture has a first row');

    const response = await fork(w, { point: first.point, selectionBinding: first.selectionBinding });

    expect(response.status).toBe(503);
    expect(response.json<{ code: string }>().code).toBe('plugin_unavailable');
  });
});
