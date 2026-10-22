import { afterEach, describe, it } from 'bun:test';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptProvenance } from '@ferretry/protocol';
import should from 'should';
import { FileSendLedger, NodeCodexRolloutIndex } from '../../../../src/adapters/index.ts';
import { NodeTranscriptSource } from '../../../../src/adapters/transcript/index.ts';
import {
  type ClockPort,
  CodexTranscriptParser,
  codexCorrelationArguments,
  parseSessionId,
  type SerialExecutor,
  type SessionId,
  SessionTranscriptReader,
  SessionTranscriptResolver,
} from '../../../../src/lib/index.ts';
import {
  AgentSendFailureNotifier,
  defaultSendTrackerSettings,
  defaultSessionSendSettings,
  type SendPaneObservation,
  type SendRepository,
  type SendTarget,
  type SendTerminal,
  SendTracker,
  SessionSendService,
  TranscriptSendEvidence,
} from '../../../../src/lib/session/send/index.ts';
import rollout0156 from '../../../fixtures/transcript/codex-rollouts/codex-0.156.1.jsonl' with { type: 'text' };

/**
 * A CLAUDE ferret sending to a CODEX ferret — the owner's "they are all ferrets" report — through the
 * REAL evidence chain: the send service types into a fake Codex pane, the fake writes the rollout real
 * Codex 0.156.1 writes, and the tracker reads it back through the same resolver, rollout index and
 * transcript source the daemon mounts. Nothing about where the message went is faked.
 *
 * The send itself always worked: the keys reached Codex. What failed was the PROOF — the rollout
 * carried nothing tying it to the session — so every send settled unconfirmed and the Claude sender
 * was told its message "did not reach" a peer that had answered it.
 */

const CODEX = parseSessionId('mvewigk9-8df3c7c0');
const CLAUDE = parseSessionId('mvewaaaa-11111111');
const T0 = Date.parse('2026-10-19T07:12:00.000Z');

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map(async home => await rm(home, { recursive: true, force: true })));
});

const inline: SerialExecutor = { run: async (_key, work) => await work(), runExclusive: async work => await work() };

/** The recorded rollout's opening records — everything Codex writes before the first user message. */
const HEADER = rollout0156.split('\n').slice(0, 8);
const ROLLOUT_ID = (JSON.parse(HEADER[0] as string) as { payload: { id: string } }).payload.id;

/** A Codex pane: whatever is typed becomes a user message in the rollout, as Codex records it. */
class FakeCodexPane {
  readonly typed: string[] = [];
  private started = false;

  constructor(
    private readonly file: string,
    private readonly header: readonly string[],
    private readonly clock: () => string,
  ) {}

  async observe(): Promise<SendPaneObservation> {
    return { alive: true, dead: false, promptReady: true, activeWork: false };
  }

  async type(text: string): Promise<void> {
    this.typed.push(text);
    // Codex writes its rollout lazily, on the first message.
    if (!this.started) await writeFile(this.file, `${this.header.join('\n')}\n`, 'utf8');
    this.started = true;
    const record = {
      timestamp: this.clock(),
      type: 'response_item',
      payload: {
        type: 'message',
        id: `msg-${this.typed.length}`,
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    };
    await appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8');
  }
}

/** A Claude pane: only what it was told matters here. */
class FakeClaudePane {
  readonly typed: string[] = [];
}

async function rig(launchedWithCorrelationRoot: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'ferretry-peer-codex-'));
  homes.push(root);
  const codexHome = join(root, 'homes', 'codex-auto');
  const token = join(root, 'state', 'sessions', CODEX);
  const day = join(codexHome, 'sessions', '2026', '10', '19');
  await mkdir(day, { recursive: true });
  const declared = codexCorrelationArguments(token)[1] as string;
  const header = HEADER.map(line =>
    line
      .replaceAll('@@CODEX_HOME@@', codexHome)
      .replaceAll('@@CWD@@', join(root, 'work'))
      // A launch before the fix declared no extra root: every recorded root is the working folder.
      .replaceAll('@@CORRELATION_ROOT@@', launchedWithCorrelationRoot ? declared : join(root, 'work')),
  );
  let nowMs = T0;
  const clock: ClockPort = { now: () => new Date(nowMs).toISOString() };
  const codex = new FakeCodexPane(join(day, `rollout-2026-10-19T07-12-08-${ROLLOUT_ID}.jsonl`), header, clock.now);
  const claude = new FakeClaudePane();

  let provenance: TranscriptProvenance = {
    v: 1,
    home: codexHome,
    identity: 'undiscovered',
    baseline: [],
    correlationToken: token,
  };
  const resolver = new SessionTranscriptResolver(
    new NodeCodexRolloutIndex(),
    { claimed: async () => [] },
    {
      record: async (_id, resolved) => {
        provenance = resolved;
      },
    },
    clock,
  );
  const reader = new SessionTranscriptReader([new NodeTranscriptSource(new CodexTranscriptParser())], {
    file: async sessionId => (sessionId === CODEX ? await resolver.file(sessionId, provenance) : undefined),
  });

  const targets = new Map<SessionId, SendTarget>([
    [CODEX, { id: CODEX, status: 'running', mode: 'interactive', turn: 1, teammate: 'zarah' }],
    [CLAUDE, { id: CLAUDE, status: 'running', mode: 'auto', turn: 1, teammate: 'hadi' }],
  ]);
  const terminal: SendTerminal = {
    observe: async () => await codex.observe(),
    deliver: async (id, text) => {
      if (id === CODEX) await codex.type(text);
      else claude.typed.push(text);
    },
    queue: async () => 'unproven',
    stopActiveTurn: async () => await codex.observe(),
    pressStopKey: async () => undefined,
    heldAt: async () => undefined,
    clearComposer: async () => 'absent',
    submitComposer: async () => 'absent',
  };
  const repository: SendRepository = {
    read: async id => targets.get(id),
    resolveSender: async reference => targets.get(reference as SessionId),
    journal: async () => undefined,
    transition: async (id, change) => {
      const next = { ...(targets.get(id) as SendTarget), ...(change.turn === undefined ? {} : { turn: change.turn }) };
      targets.set(id, next);
      return next;
    },
  };
  const ledger = new FileSendLedger(id => join(root, 'ledger', id), clock);
  let service: SessionSendService | undefined;
  const tracker = new SendTracker(
    {
      ledger,
      evidence: new TranscriptSendEvidence(
        async sessionId => ({ sessionId, harness: sessionId === CODEX ? 'codex' : 'claude' }),
        reader,
      ),
      terminal,
      repository,
      attempts: {
        reattempt: async (id, sendId) => await (service as SessionSendService).reattempt(id, sendId, { by: 'daemon' }),
        resubmit: async (id, sendId) => await (service as SessionSendService).resubmit(id, sendId),
      },
      notifier: new AgentSendFailureNotifier(
        { send: async request => await (service as SessionSendService).send(request) },
        repository,
        'fy',
      ),
      scheduler: { schedule: () => undefined, cancelAll: () => undefined },
      roster: { sessions: () => [CODEX, CLAUDE] },
      serial: inline,
      clock,
    },
    defaultSendTrackerSettings,
  );
  service = new SessionSendService(
    {
      repository,
      ledger,
      terminal,
      turns: {
        writeTurn: async (id, turn) => join(root, 'state', 'sessions', id, 'turns', `turn-${turn}.md`),
        writeQueuedPayload: async (id, sendId) => join(root, 'state', 'sessions', id, 'channel', `queued-${sendId}.md`),
        clearMarkers: async () => undefined,
      },
      channel: { recordInbound: async () => undefined, recordOutbound: async () => undefined },
      gate: { launching: () => false, awaitSettled: async () => true },
      reviver: { revive: async () => undefined },
      peerWaits: { endPeerWait: async () => undefined },
      serial: inline,
      clock,
      tracking: tracker,
    },
    defaultSessionSendSettings,
  );

  return {
    codex,
    claude,
    service,
    ledger,
    provenance: () => provenance,
    /** One tracker look at the Codex session, `ms` after the send. */
    at: async (ms: number) => {
      nowMs = T0 + ms;
      await tracker.check(CODEX);
      return (await ledger.list(CODEX)).find(entry => entry.sendId === 'send-1');
    },
  };
}

describe('a Claude ferret sending to a Codex ferret', () => {
  it('is delivered, with no failure notice, once the Codex launch declared its correlation root', async () => {
    // Arrange
    const subject = await rig(true);

    // Act
    await subject.service.send({ id: CODEX, sendId: 'send-1', message: 'please review #612', senderReference: CLAUDE });
    const record = await subject.at(2_000);

    // Assert: the rollout is bound to the Codex session, and the sender is told nothing went wrong.
    should(subject.codex.typed).have.length(1);
    should(record).match({ fate: 'delivered' });
    should(subject.provenance()).match({ identity: 'correlated' });
    should(subject.claude.typed).be.empty();
  });

  it('leaves an owner’s one-line message unconfirmable on an unbound session, and a peer send then binds it', async () => {
    // Arrange: a Codex session launched before the fix, which the owner's Mac was running.
    const subject = await rig(false);

    // Act: the owner says "hello" (typed directly), then a Claude ferret sends a peer message.
    await subject.service.send({ id: CODEX, sendId: 'send-1', message: 'hello' });
    const hello = await subject.at(60_000);
    await subject.service.send({ id: CODEX, sendId: 'send-2', message: 'please review #612', senderReference: CLAUDE });
    await subject.at(61_000);
    const peer = (await subject.ledger.list(CODEX)).find(entry => entry.sendId === 'send-2');
    const helloAfter = (await subject.ledger.list(CODEX)).find(entry => entry.sendId === 'send-1');

    // Assert: "hello" is said as unprovable, never retyped; the peer message travels by turn-file
    // pointer, whose path names the session directory, so it proves the rollout and is delivered.
    should(hello).match({ fate: 'unaccounted', unaccountedReason: 'transcript_unbound', retryable: false });
    should(subject.codex.typed).have.length(2);
    should(subject.codex.typed[1]).match(/^Read the file .*\/turns\/turn-\d+\.md now/);
    should(peer).match({ fate: 'delivered', path: 'turn-file' });
    // And the bound rollout settles the earlier message honestly: it did arrive.
    should(helloAfter).match({ fate: 'delivered' });
    should(subject.provenance()).match({ identity: 'correlated' });
    should(subject.claude.typed).be.empty();
  });
});
