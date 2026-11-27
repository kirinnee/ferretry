import { describe, it } from 'bun:test';
import { ApiError, type FerretId } from '@ferretry/kernel/contract';
import { ownerStanding } from '@ferretry/core-gate/contract/testing';
import type { HarnessKey, HarnessTailRecord } from '../../../contract/index.ts';
import { FakeHarness, THIRD_HARNESS_KEY } from '../../../contract/testing/index.ts';
import { eventOfRecord, HarnessTranscript } from '../../../daemon/adapters/session/live/harness-transcript.ts';
import { StorageLiveActivitySource } from '../../../daemon/adapters/session/live/storage-live-activity.ts';
import { FY_REQUEST_ID_HEADER } from '../../../daemon/lib/protocol/headers.ts';
import { registryLeaseSessions } from '../../../daemon/lib/session/lifecycle/conversation-leases.ts';
import { MovePreflight, type MoveTargetView } from '../../../daemon/lib/moves/preflight-service.ts';
import type { MovePane, ProcessInventoryPort } from '../../../daemon/lib/moves/process-inventory-port.ts';
import { sessionMoveRoutes } from '../../../daemon/lib/runtime/mounts/session-move.ts';
import { sessionMoveModule } from '../../../daemon/modules/session-move.ts';
import { sessionView } from '../../support/daemon/session-view.ts';
import { requestOf } from '../daemon/support/requests.ts';
import { sessionMoveNeedsForTest } from '../daemon/modules/session-move/fixture.ts';
import { expectGolden } from './golden-file.ts';

/**
 * E-276 PR 0b: how Ferrets decides which transcript FORMAT a harness is read as, captured on the base.
 *
 * Six decisions are pinned, each for Claude (`claude-code`), Codex (`codex`) and a third harness key
 * (`fake-third`, a harness the contract has never heard of), plus the keys' edge spellings:
 *   1. `eventOfRecord`: every tail-record kind, with and without its optional fields, in each family.
 *   2. `HarnessTranscript.tail`: the key -> family that stamps each event, and `unreadable` for a key with none.
 *   3. The live readout's family when a tail carries no event (it answers Claude).
 *   4. The move's transcript family (`transcriptHarnessOf`), reached through the mounted route.
 *   5. The conversation-lease history pool of a harness key.
 *   6. The preflight's background-terminal count, which only a Codex session reports.
 *
 * Every input is synthetic and fixed; nothing here reads a clock, a path, a random id or the host's environment.
 */

const AT = '2026-11-08T10:00:00.000Z' as HarnessTailRecord['at'];

const RECORDS: Record<string, HarnessTailRecord> = {
  messageBare: { kind: 'message', role: 'user' } as never,
  messageFull: { kind: 'message', role: 'assistant', inputSource: 'harness', at: AT } as never,
  workBare: { kind: 'work' } as never,
  workAt: { kind: 'work', at: AT } as never,
  turnStarted: { kind: 'turn', state: 'started', at: AT } as never,
  turnCompleted: { kind: 'turn', state: 'completed' } as never,
  usageBare: { kind: 'usage' } as never,
  usageFull: {
    kind: 'usage',
    call: 'call-1',
    inputTokens: 10,
    outputTokens: 20,
    cachedInputTokens: 3,
    cacheCreationInputTokens: 4,
    contextTokens: 50,
    at: AT,
  } as never,
  compactionBare: { kind: 'compaction' } as never,
  compactionFull: { kind: 'compaction', trigger: 'auto', tokensBefore: 900, tokensAfter: 100, at: AT } as never,
  errorBare: { kind: 'error' } as never,
  errorLimit: { kind: 'error', code: 'usage_limit_exceeded', notice: 'You hit your usage limit.', at: AT } as never,
};

/** The keys every decision is asked about: both shipped harnesses, a third, the family word, and an empty key. */
const KEYS = ['claude-code', 'codex', THIRD_HARNESS_KEY, 'claude', ''] as const;

describe('E-276 0b golden: which transcript format a harness is read as', () => {
  it('should pin eventOfRecord for every record kind in each family', () => {
    const events: Record<string, unknown> = {};
    for (const family of ['claude', 'codex'] as const)
      for (const [name, record] of Object.entries(RECORDS)) events[`${family}/${name}`] = eventOfRecord(family, record);
    expectGolden('event-of-record', events);
  });

  it('should pin the family each harness key reads its tail as', async () => {
    const ferret = 'wren-1' as FerretId;
    const answers: Record<string, unknown> = {};
    for (const key of KEYS) {
      const harness = new FakeHarness(key as HarnessKey);
      harness.transcripts.set(ferret, {
        stamp: { file: '<TRANSCRIPT>', size: 5, mtimeMs: 7 },
        records: [RECORDS['messageBare']!, RECORDS['workAt']!, RECORDS['turnCompleted']!],
      });
      const transcript = new HarnessTranscript(
        () => harness,
        () => key as HarnessKey,
      );
      answers[`key=${key === '' ? '<empty>' : key}`] = await transcript.tail.tail(ferret, 10);
    }
    // A ferret whose key nobody can name is unresolved, whatever its harness offers.
    const harness = new FakeHarness('claude-code');
    harness.transcripts.set(ferret, { stamp: { file: '<TRANSCRIPT>', size: 5, mtimeMs: 7 }, records: [] });
    answers['key=<undefined>'] = await new HarnessTranscript(
      () => harness,
      () => undefined,
    ).tail.tail(ferret, 10);
    expectGolden('tail-family-of-key', answers);
  });

  it('should pin the family the live readout answers when its tail carries no event', async () => {
    const asked: Record<string, unknown> = {};
    for (const [name, events] of [
      ['empty-tail', []],
      ['codex-tail', [eventOfRecord('codex', RECORDS['turnStarted']!)]],
      ['claude-tail', [eventOfRecord('claude', RECORDS['turnStarted']!)]],
    ] as const) {
      const durationsAskedFor: unknown[] = [];
      const source = new StorageLiveActivitySource(
        {
          readState: async () => ({ id: 's1', status: 'running', turn: 1 }),
          paneState: async () => undefined,
          transcriptFile: async () => '<TRANSCRIPT>',
          transcriptStat: async () => ({ size: 5, mtimeMs: 7 }),
        },
        { tail: async () => ({ kind: 'read', events }) },
        { now: () => '2026-11-08T10:00:30.000Z' },
        {
          durations: async (harness, model) => {
            durationsAskedFor.push({ harness, model: model ?? null });
            return [];
          },
          record: async () => {},
        },
      );
      await source.sample('s1', new AbortController().signal);
      asked[name] = durationsAskedFor;
    }
    expectGolden('live-activity-family', asked);
  });

  it('should pin the transcript family a move reads for each harness spelling', async () => {
    const answers: Record<string, unknown> = {};
    for (const harness of ['claude', 'claude-code', 'codex', THIRD_HARNESS_KEY]) {
      const tails: unknown[] = [];
      const inspected: unknown[] = [];
      const view = sessionView('wren', { harness });
      const needs = sessionMoveNeedsForTest({
        storage: {
          findSession: () => ({}),
          readConfig: async () => view.config,
          readState: async () => view.state,
        } as never,
        restart: { record: () => ({ runtime: 'claude-auto', handle: 'pane-1' }) } as never,
        pane: () => ({}) as never,
        preflight: {
          inspect: async (target: { harness: string }, chat: unknown) => {
            inspected.push({ harness: target.harness, chat });
            throw new Error('preflight stops here');
          },
        } as never,
        transcripts: {
          tail: async (request: { harness: string }) => {
            tails.push({ harness: request.harness });
            return [];
          },
        } as never,
      });
      const routes = sessionMoveRoutes(sessionMoveModule.build(needs, undefined, undefined).provides, 1);
      const route = routes.find(candidate => candidate.path === '/v1/ferrets/:ferretId/move');
      if (route === undefined) throw new Error('no move route');
      let outcome: unknown;
      try {
        await route.handle(
          requestOf({
            method: 'POST',
            path: '/v1/ferrets/wren/move',
            params: { ferretId: 'wren' },
            headers: { [FY_REQUEST_ID_HEADER]: 'req-1' },
            body: { agent: 'claude-auto' },
            standing: ownerStanding(),
          }),
        );
        outcome = 'answered';
      } catch (error) {
        outcome =
          error instanceof ApiError
            ? { status: error.status, code: error.code, mentionsHarness: error.message.includes(harness) }
            : 'stopped in the preflight';
      }
      answers[`harness=${harness}`] = { tails, inspected, outcome };
    }
    expectGolden('move-transcript-family', answers);
  });

  it('should pin the conversation-lease history pool of each harness key', () => {
    const answers: Record<string, unknown> = {};
    for (const key of KEYS) {
      const sessions = registryLeaseSessions(
        { get: () => ({ harness: key as HarnessKey, runtime: 'runtime-a', state: 'running' }) as never },
        async () => ({}),
      );
      answers[`key=${key === '' ? '<empty>' : key}`] = sessions.launchOf('s1' as never) ?? null;
    }
    expectGolden('lease-history-pool', answers);
  });

  it('should pin which harness spelling the preflight counts background terminals for', async () => {
    const footer = 'Esc to interrupt · 2 background terminals running';
    const inventory: ProcessInventoryPort = {
      collect: async () => ({ kind: 'observed', processes: [] }),
    };
    const answers: Record<string, unknown> = {};
    for (const harness of ['claude', 'claude-code', 'codex', THIRD_HARNESS_KEY]) {
      const pane: MovePane = { identify: async () => undefined, screen: async () => footer };
      const view: MoveTargetView = {
        sessionId: 'session-1',
        harness,
        pane,
        status: 'waiting',
        turn: 3,
        openTools: [],
      };
      const report = await new MovePreflight(inventory).inspect(view);
      answers[`harness=${harness}`] = {
        codexBackgroundTerminals: report.codexBackgroundTerminals,
        blindSpots: report.blindSpots,
      };
    }
    expectGolden('preflight-background-terminals', answers);
  });
});
