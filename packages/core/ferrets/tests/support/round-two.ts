import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate, StandInAdmission, ferretStanding, ownerStanding } from '@ferretry/core-gate/contract/testing';
import { FakeRedaction, FakeVault } from '@ferretry/core-vault/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import type { Redaction } from '@ferretry/kernel/contract';
import { FerretFiles, Harnesses, Runners, SitrepLines, type FerretRecord } from '../../contract/index.ts';
import { ferretId, FakeHarness, FakeRunner, T0 } from '../../contract/testing/index.ts';
import ferrets from '../../daemon/index.ts';

const record = (id: string, parent?: string): FerretRecord => ({
  format: 1,
  id: ferretId(id),
  name: id,
  role: parent ? 'helper' : 'lead',
  ...(parent ? { parent: ferretId(parent) } : {}),
  harness: 'claude-code',
  runner: 'tmux',
  folder: `/work/${id}`,
  state: 'working',
  createdAt: T0,
  stateAt: T0,
  handle: `pane-${id}` as never,
});
export async function subtreeHost(redaction?: Redaction) {
  const runner = new FakeRunner();
  const looked: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const masker = redaction ?? new FakeRedaction(new Map([['fixture' as never, 'fixture-secret-tail']]));
  const source = implementDaemon(
    definePlugin({
      id: 'conversation',
      title: 'fixture',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: SitrepLines }] },
    }),
    {
      build: () => ({
        hooks: {
          'sitrep.lines': () => [
            {
              id: 'fixture',
              item: {
                lines: async (id: string) => {
                  looked.push(id);
                  inFlight++;
                  peak = Math.max(peak, inFlight);
                  await new Promise<void>(resolve => setImmediate(resolve));
                  inFlight--;
                  return [{ kind: 'note' as const, at: T0, text: `${'x'.repeat(95)}fixture-secret-tail` }];
                },
              },
            },
          ],
        },
      }),
    },
  );
  const runnerPlugin = implementDaemon(
    definePlugin({
      id: 'terminals',
      title: 'fixture',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Runners, key: 'tmux' }] },
    }),
    { build: () => ({ hooks: { 'runners:tmux': runner } }) },
  );
  const harnessPlugin = implementDaemon(
    definePlugin({
      id: 'claude-code',
      title: 'fixture',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Harnesses, key: 'claude-code' }] },
    }),
    { build: () => ({ hooks: { 'harnesses:claude-code': new FakeHarness() } }) },
  );
  const h = await testHost({
    gate: new StandInAdmission(request => {
      const id = request.headers.get('x-test-ferret');
      return id ? ferretStanding(ferretId(id)) : ownerStanding();
    }),
    plugins: [ferrets, source, runnerPlugin, harnessPlugin],
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
    redaction: masker,
  });
  for (const r of [
    record('lead'),
    ...Array.from({ length: 70 }, (_, i) => record(`kid-${String(i).padStart(2, '0')}`, 'lead')),
    record('stranger'),
  ])
    h.state('ferrets').plant(FerretFiles, JSON.stringify(r), r.id);
  return { h: await h.restart(), looked, masker, peak: () => peak };
}
