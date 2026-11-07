import { FakeAsks } from '@ferretry/core-asks/contract/testing';

import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { ApiRequest, CallStanding } from '@ferretry/kernel/contract';
import { definePlugin } from '@ferretry/kernel/manifest';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import {
  FerretFiles,
  type FerretId,
  type FerretRecord,
  Harnesses,
  Runners,
} from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner, ferretId, T0 } from '../../../../contract/testing/index.ts';
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

export async function host(
  records: readonly FerretRecord[] = [],
  extra: {
    readonly harness?: FakeHarness;
    readonly runner?: FakeRunner;
    readonly config?: Readonly<Record<string, unknown>>;
  } = {},
): Promise<TestHost> {
  const plugins = [
    ferrets,
    ...(extra.harness === undefined ? [] : [harnessPlugin(extra.harness)]),
    ...(extra.runner === undefined ? [] : [runnerPlugin(extra.runner)]),
  ];
  const first = await testHost({
    plugins,
    gate: new StandInAdmission(standingFor),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
    ...(extra.config === undefined ? {} : { config: extra.config }),
  });
  if (records.length === 0) return first;
  for (const each of records) first.state('ferrets').plant(FerretFiles, JSON.stringify(each), each.id);
  return await first.restart();
}
