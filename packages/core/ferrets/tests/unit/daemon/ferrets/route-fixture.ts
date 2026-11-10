import { FakeAsks } from '@ferretry/core-asks/contract/testing';

import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { ApiRequest, CallStanding } from '@ferretry/kernel/contract';
import { definePlugin } from '@ferretry/kernel/manifest';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import {
  FerretFiles,
  FerretsPort,
  type FerretId,
  type FerretRecord,
  Harnesses,
  OPENING_ATTACHMENTS_KEY,
  OpeningAttachments,
  type OpeningAttachmentsSource,
  Runners,
  StartDecide,
  type StartDecideInput,
} from '../../../../contract/index.ts';
import { type FakeHarness, type FakeRunner, ferretId, T0 } from '../../../../contract/testing/index.ts';
import ferrets from '../../../../daemon/index.ts';

/** Who calls: the `x-test-caller` header names a ferret (`ferret:<id>`), else the owner at the machine. */
const callerHeader = 'x-test-caller';
const standingFor = (request: ApiRequest): CallStanding => {
  const raw = request.headers.get(callerHeader);
  return raw?.startsWith('ferret:') === true ? ferretStanding(raw.slice(7) as FerretId) : ownerStanding();
};
export const as = (ferret: string) => ({ headers: { [callerHeader]: `ferret:${ferret}` } });

export const record = (id: string, parent?: string, folder = `/work/${id}`): FerretRecord => ({
  format: 1,
  id: ferretId(id),
  name: id,
  ...(parent === undefined ? {} : { parent: ferretId(parent) }),
  role: parent === undefined ? 'lead' : 'helper',
  harness: 'claude-code',
  runner: 'tmux',
  folder,
  state: 'working',
  createdAt: T0,
  stateAt: T0,
});

/** The two plugins on the security path that take Ferrets' provide hooks, as fakes with their real ids. */
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

/**
 * A stand-in for the owner of attachments on `opening.attachments` (a security-path provide hook): a plugin with an id
 * `id` (Conversation's real id by default, the only taker the hook names) that provides `source` under the hook's one key.
 */
export const fakeAttachmentsOwner = (source: OpeningAttachmentsSource, id = 'conversation') =>
  implementDaemon(
    definePlugin({
      id,
      title: 'Attachments owner (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: OpeningAttachments, key: OPENING_ATTACHMENTS_KEY }] },
    }),
    { build: () => ({ hooks: { 'opening.attachments:opening': source } }) },
  );

/**
 * A stand-in consumer of the Ferrets port with a real plugin id (`warden`, `packs`, `lessons`…): the kernel binds the
 * port per consumer, so a test that acts as that plugin takes it with `host.provided(FerretsPort, id)`. It takes no hook.
 */
export const portConsumer = (id: string) =>
  implementDaemon(
    definePlugin({
      id,
      title: `${id} (fake consumer)`,
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      needs: { ferrets: FerretsPort },
    }),
    { build: () => ({}) },
  );

/**
 * A stand-in for Packs: a plugin with Packs' real id that takes `start.decide` and answers `answer` (anything, garbage
 * included), recording what it was asked. It also needs the Ferrets port, so a test takes the port as Packs with
 * `host.provided(FerretsPort, 'packs')`. Its own yes on `start.decide` is what admits a child (RULING #43).
 */
export const fakePacks = (answer: (input: StartDecideInput) => unknown = () => ({ allow: true })) => {
  const asked: StartDecideInput[] = [];
  const plugin = implementDaemon(
    definePlugin({
      // Packs' manifest id, written out rather than read from the constant under test: a wrong answerer id goes red.
      id: 'packs',
      title: 'Packs (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      needs: { ferrets: FerretsPort },
      hooks: { takes: [{ hook: StartDecide }] },
    }),
    {
      build: () => ({
        hooks: {
          'start.decide': async (input: StartDecideInput) => {
            asked.push(input);
            return (await answer(input)) as never;
          },
        },
      }),
    },
  );
  return { asked, plugin };
};

export async function host(
  records: readonly FerretRecord[] = [],
  extra: {
    readonly harness?: FakeHarness;
    readonly runner?: FakeRunner;
    readonly config?: Readonly<Record<string, unknown>>;
    /** Who calls; `undefined` is a call with no credential. */
    readonly standing?: (request: ApiRequest) => CallStanding | undefined;
    /** What `RootHandle.pin` answers: the kernel's descriptor walk, or a stand-in for it. */
    readonly pinner?: Parameters<typeof testHost>[0]['pinner'];
    /** Answers the Git the file browser runs. */
    readonly spawn?: Parameters<typeof testHost>[0]['spawn'];
    /** More plugins on the host (a fake taker of a Ferrets hook). */
    readonly plugins?: Parameters<typeof testHost>[0]['plugins'];
  } = {},
): Promise<TestHost> {
  const plugins = [
    ferrets,
    ...(extra.harness === undefined ? [] : [harnessPlugin(extra.harness)]),
    ...(extra.runner === undefined ? [] : [runnerPlugin(extra.runner)]),
    ...(extra.plugins ?? []),
  ];
  const first = await testHost({
    plugins,
    gate: new StandInAdmission(extra.standing ?? standingFor),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
    ...(extra.config === undefined ? {} : { config: extra.config }),
    ...(extra.pinner === undefined ? {} : { pinner: extra.pinner }),
    ...(extra.spawn === undefined ? {} : { spawn: extra.spawn }),
  });
  if (records.length === 0) return first;
  for (const each of records) first.state('ferrets').plant(FerretFiles, JSON.stringify(each), each.id);
  return await first.restart();
}
