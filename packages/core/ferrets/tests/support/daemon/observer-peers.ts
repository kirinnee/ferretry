/**
 * The session observer's host-provided peers, as a core test can have them.
 *
 * Ferrets is core and cannot import a plugin's code (§2.1), so the question projection and answer reconciliation
 * (conversation), the observed-runtime projection (claude-code, codex), the pane parsers (terminals), the pane work
 * classifier (warden) and the transcript parsers (conversation) are handed in by the host. A core test has none of
 * them, so this file offers two kinds of stand-in (the scripted ones that answer real scenarios are in `observer-stand-ins.ts`):
 *
 * - INERT: answers nothing — no question, no runtime, no pane signal, no work under the pane. For a test whose
 *   subject only passes through that behaviour.
 * - UNWIRED: throws, naming the peer. For a test whose assertion IS that behaviour: it fails loudly, saying which
 *   peer it needs, until the host's implementation is wired into the test (or the test moves to its owner).
 */
import type { QuestionStepPolicy } from '../../../daemon/lib/session/observer/question.ts';
import { stepTurn, type TurnLook, type TurnStateChange } from '../../../daemon/lib/session/observer/turn.ts';
import type { AnswerLedger, AnswerOperationRecord } from '../../../daemon/lib/session/peers/question.ts';
import type { TranscriptSendEvidenceFactory } from '../../../daemon/lib/session/peers/send.ts';
import type { PaneParsers } from '../../../daemon/lib/session/peers/tmux.ts';
import type {
  IncrementalTranscriptTailFactory,
  TranscriptHarness,
  TranscriptSource,
} from '../../../daemon/lib/session/peers/transcript.ts';
import {
  isTurnStatus,
  type SessionTurnPorts,
  type SessionTurnWatcher,
  type SessionTurnWatcherFactory,
  TURN_WATCH_INTERVAL_MS,
  type TurnObservation,
  type TurnWatchReport,
  type TurnWatchSession,
} from '../../../daemon/lib/session/peers/turn.ts';
import type { PaneWorkSummarizer } from '../../../daemon/lib/session/peers/warden.ts';
import type { SessionId } from '../../../daemon/lib/session-id.ts';

/** The error an UNWIRED peer throws. */
class UnwiredPeer extends Error {
  constructor(peer: string) {
    super(`host peer not wired in core: ${peer}`);
    this.name = 'UnwiredPeer';
  }
}

const unwired = (peer: string) => (): never => {
  throw new UnwiredPeer(peer);
};

/** A question part that finds no question, settles no receipt and observes no runtime. */
export const INERT_QUESTIONS: QuestionStepPolicy = Object.freeze<QuestionStepPolicy>({
  projectStructuredQuestion: () => ({ kind: 'none' as const }),
  structuredQuestionStatePatch: () => ({}),
  reconcileAnswerEvidence: records => ({ records, settlements: [] }),
  withAskedQuestion: events => events,
  projectObservedContext: () => undefined,
  projectObservedRuntime: () => ({}),
  observedRuntimeStatePatch: () => ({}),
});

/** The question part as the conversation and harness plugins implement it: not available in core. */
export const UNWIRED_QUESTIONS: QuestionStepPolicy = Object.freeze({
  projectStructuredQuestion: unwired('projectStructuredQuestion (conversation)'),
  structuredQuestionStatePatch: unwired('structuredQuestionStatePatch (conversation)'),
  reconcileAnswerEvidence: unwired('reconcileAnswerEvidence (conversation)'),
  withAskedQuestion: unwired('withAskedQuestion (conversation)'),
  projectObservedContext: unwired('projectObservedContext (claude-code, codex)'),
  projectObservedRuntime: unwired('projectObservedRuntime (claude-code, codex)'),
  observedRuntimeStatePatch: unwired('observedRuntimeStatePatch (claude-code, codex)'),
});

/** Pane parsers that read nothing on any frame: no prompt, no work, no dialog. */
export const INERT_PANE_PARSERS: PaneParsers = Object.freeze({
  parsePermissionPrompt: () => undefined,
  paneActiveWork: () => undefined,
  paneShowsPermissionPrompt: () => false,
  paneBlockingPrompt: () => undefined,
  idlePromptShown: () => false,
  parseHarnessDialog: () => undefined,
});

/** No tool command, no leftover browser, whatever runs under the pane. */
export const INERT_PANE_WORK: PaneWorkSummarizer = () => ({ toolCommand: false, leftoverBrowser: false });

/**
 * An answer ledger in memory, in place of today's `FileAnswerLedger` (conversation): every appended row is kept in
 * order, and the latest row per request id is the one `read` and `all` answer — the file ledger's own rule.
 */
export class MemoryAnswerLedger implements AnswerLedger {
  private readonly appended = new Map<string, AnswerOperationRecord[]>();

  async read(id: SessionId, requestId: string): Promise<AnswerOperationRecord | undefined> {
    return (await this.all(id)).get(requestId);
  }

  async all(id: SessionId): Promise<ReadonlyMap<string, AnswerOperationRecord>> {
    return new Map((this.appended.get(id) ?? []).map(row => [row.requestId, row]));
  }

  async append(id: SessionId, record: AnswerOperationRecord): Promise<void> {
    this.appended.set(id, [...(this.appended.get(id) ?? []), record]);
  }

  /** Every row appended for the session, oldest first. */
  rows(id: SessionId): readonly AnswerOperationRecord[] {
    return this.appended.get(id) ?? [];
  }
}

/**
 * Today's `SessionTurnWatcher` (conversation `lib/session/turn/service.ts`), copied for core tests: a loop that
 * gathers each look through its ports and records what Ferrets' own `stepTurn` answers. Everything it decides is
 * the observer's, so a host test can drive its turn tick without the conversation plugin.
 */
class TestTurnWatcher implements SessionTurnWatcher {
  readonly intervalMs = TURN_WATCH_INTERVAL_MS;
  private readonly previous = new Map<SessionId, TurnObservation | undefined>();
  private running = false;

  constructor(private readonly ports: SessionTurnPorts) {}

  async run(): Promise<TurnWatchReport | undefined> {
    if (this.running) return undefined;
    this.running = true;
    try {
      return await this.tick();
    } catch {
      return undefined;
    } finally {
      this.running = false;
    }
  }

  async tick(): Promise<TurnWatchReport> {
    const sessions = await this.ports.sessions();
    const changed = new Map<SessionId, TurnStateChange>();
    const failures = new Map<SessionId, string>();
    for (const session of sessions) {
      try {
        const change = await this.watch(session);
        if (change !== undefined) changed.set(session.id, change);
      } catch (error) {
        failures.set(session.id, error instanceof Error ? error.message : String(error));
      }
    }
    const roster = new Set(sessions.map(session => session.id));
    for (const id of this.previous.keys()) if (!roster.has(id)) this.previous.delete(id);
    return { changed, failures };
  }

  private async watch(session: TurnWatchSession): Promise<TurnStateChange | undefined> {
    let look: TurnLook | undefined;
    if (isTurnStatus(session.state.status)) {
      const [transcript, pane] = await Promise.all([this.ports.transcript(session.id), this.ports.pane(session.id)]);
      look = { transcript, pane };
    }
    const step = stepTurn(session.state, this.previous.get(session.id), look);
    this.previous.set(session.id, step.observation);
    if (step.change === undefined) return undefined;
    return (await this.ports.record(session.id, step.change, this.ports.clock.now())) ? step.change : undefined;
  }
}

/** Builds a {@link TestTurnWatcher}: the `turnWatcher` port a core host test hands in. */
export const testTurnWatcher: SessionTurnWatcherFactory = ports => new TestTurnWatcher(ports);

/** Today's `NodeTranscriptSource` over a harness's parser (conversation): every read throws, naming it. */
export function unwiredTranscriptSource(harness: TranscriptHarness): TranscriptSource {
  const peer = `NodeTranscriptSource(${harness === 'claude' ? 'ClaudeTranscriptParser' : 'CodexTranscriptParser'}) (conversation)`;
  return {
    harness,
    read: unwired(peer),
    follow: unwired(peer),
    window: unwired(peer),
  };
}

/** Today's `new IncrementalTranscriptTail(source, file, sessionId, limit)` (conversation): reading it throws. */
export const UNWIRED_TAIL: IncrementalTranscriptTailFactory = (_source, file) => ({
  file,
  read: unwired('IncrementalTranscriptTail (conversation)'),
});

/** Today's `new TranscriptSendEvidence(target, reader)` (conversation): reading it throws. */
export const UNWIRED_SEND_EVIDENCE: TranscriptSendEvidenceFactory = () => ({
  read: unwired('TranscriptSendEvidence (conversation)'),
});
