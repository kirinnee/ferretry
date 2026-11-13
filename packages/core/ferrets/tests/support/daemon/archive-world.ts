/**
 * A Ferrets host with the archive switched on and Board and Agenda stood in by fakes with their real ids, each
 * contributing its half of `session.archive-keeps` (U6). A test starts ferrets, finishes them, moves the clock past the
 * archive's age and runs the job, then reads `GET /v1/archived-sessions` and the archive document.
 */
import { randomUUID } from 'node:crypto';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import {
  type ArchiveCardStanding,
  ArchiveKeeps,
  type ArchiveKeepSource,
  type FerretId,
  Harnesses,
  Runners,
} from '../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../contract/testing/index.ts';
import { fakePacks } from '../../unit/daemon/ferrets/route-fixture.ts';
import ferrets from '../../../daemon/index.ts';
import type { ArchivedSessions } from '../../../daemon/lib/protocol/session.ts';
import { ARCHIVE_PASS_JOB } from '../../../daemon/modules/archive.ts';

export const HOUR_MS = 3_600_000;

/** What Board says: the cards it holds, and whether it can answer at all. */
class FakeBoard {
  cards: ArchiveCardStanding[] = [];
  broken = false;
  asked = 0;
  source(): ArchiveKeepSource {
    return {
      kind: 'board',
      cards: async () => {
        this.asked += 1;
        if (this.broken) throw new Error('the board could not be read');
        return this.cards;
      },
    };
  }
}

/** What Agenda says: the ferrets whose own board holds an open item, and whether it can answer at all. */
class FakeAgenda {
  open = new Set<string>();
  broken = false;
  /** Answers instead of the set when present (a look that hangs, or one that changes with the call). */
  answer: ((ferret: string) => boolean | Promise<boolean>) | undefined;
  asked: string[] = [];
  source(): ArchiveKeepSource {
    return {
      kind: 'agenda',
      hasOpenItem: async ferret => {
        this.asked.push(ferret);
        if (this.broken) throw new Error('the agenda could not be read');
        return this.answer === undefined ? this.open.has(ferret) : await this.answer(ferret);
      },
    };
  }
}

const keeper = (id: 'board' | 'agenda', source: unknown) =>
  implementDaemon(
    definePlugin({
      id,
      title: `${id} (fake)`,
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: ArchiveKeeps }] },
    }),
    { build: () => ({ hooks: { 'session.archive-keeps': () => [{ id, item: source as ArchiveKeepSource }] } }) },
  );

const harnessPlugin = (harness: FakeHarness) =>
  implementDaemon(
    definePlugin({
      id: 'claude-code',
      title: 'Claude Code (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Harnesses, key: 'claude-code' }] },
    }),
    { build: () => ({ hooks: { 'harnesses:claude-code': harness } }) },
  );
const runnerPlugin = (runner: FakeRunner) =>
  implementDaemon(
    definePlugin({
      id: 'terminals',
      title: 'Terminals (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Runners, key: 'tmux' }] },
    }),
    { build: () => ({ hooks: { 'runners:tmux': runner } }) },
  );

export interface ArchiveWorldOptions {
  /** What `archive.yaml` says; absent writes no file at all. */
  readonly afterHours?: number | 'off';
  /** Leave Board's half out (the plugin is not there). */
  readonly noBoard?: boolean;
  /** Leave Agenda's half out. */
  readonly noAgenda?: boolean;
  /** What Board contributes INSTEAD of its keep source (a garbage item the hook must refuse). */
  readonly boardItem?: unknown;
  /** Packs stands in, admitting every helper (a child start needs its yes, ruling #43). */
  readonly packs?: boolean;
}

export async function archiveWorld(options: ArchiveWorldOptions = {}) {
  const board = new FakeBoard();
  const agenda = new FakeAgenda();
  const runner = new FakeRunner();
  const harness = new FakeHarness();
  const h = await testHost({
    everyDirectory: true,
    plugins: [
      ferrets,
      harnessPlugin(harness),
      runnerPlugin(runner),
      ...(options.noBoard === true
        ? []
        : [keeper('board', 'boardItem' in options ? options.boardItem : board.source())]),
      ...(options.noAgenda === true ? [] : [keeper('agenda', agenda.source())]),
      ...(options.packs === true ? [fakePacks().plugin] : []),
    ],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
    ...(options.afterHours === undefined ? {} : { config: { 'archive.yaml': { afterHours: options.afterHours } } }),
  });
  return { h, board, agenda, runner, harness };
}

/** Starts a ferret (autonomous unless `mode` says a person drives it) and returns its id. */
export async function startFerret(
  h: TestHost,
  name: string,
  more: { readonly mode?: 'auto' | 'interactive'; readonly parent?: string } = {},
): Promise<FerretId> {
  const answer = await h.request('POST', '/v1/ferrets', {
    body: { name, folder: `/work/${name}`, ...(more.mode === undefined ? {} : { mode: more.mode }) },
    headers: { 'x-fy-request-id': randomUUID() },
  });
  if (answer.status !== 201) throw new Error(`start ${name}: ${String(answer.status)} ${answer.body}`);
  return answer.json<{ id: FerretId }>().id;
}

/** Lets every timer the clock moved, and every write they started, run to its end. */
export async function settle(h: TestHost): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) {
    await h.clock.advance(0);
    await Bun.sleep(0);
  }
  await h.settle();
}

/** Stops a ferret and waits until its state document says so (the document follows the registry on its own lane). */
export async function finishFerret(h: TestHost, id: FerretId): Promise<void> {
  const stopped = await h.request('POST', `/v1/ferrets/${id}/stop`, { body: {} });
  if (stopped.status >= 300) throw new Error(`stop ${id}: ${String(stopped.status)}`);
  await settle(h);
}

/** Moves the clock and settles. */
export async function pass(h: TestHost, by: number): Promise<void> {
  await h.clock.advance(by);
  await settle(h);
}

/** Runs the archive job once, as a tick does (it runs a pass only when one is due). */
export async function tickArchive(h: TestHost): Promise<void> {
  await h.runJob(ARCHIVE_PASS_JOB);
  await settle(h);
}

/** `GET /v1/archived-sessions`: how many, and the newest `limit` as ordinary views. */
export async function archived(h: TestHost, limit = 100): Promise<ArchivedSessions> {
  const answer = await h.request('GET', '/v1/archived-sessions', { query: { limit: String(limit) } });
  if (answer.status !== 200) throw new Error(`archived: ${String(answer.status)} ${answer.body}`);
  return answer.json<ArchivedSessions>();
}
