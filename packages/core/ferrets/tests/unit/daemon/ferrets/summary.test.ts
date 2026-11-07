import { expect, test } from 'bun:test';
import { ok } from '@ferretry/std';
import type { FerretId, FerretRecord, FerretState } from '../../../../contract/index.ts';
import {
  emptyChildEnvironment,
  FakeHarness,
  FakeRunner,
  fenced,
  ferretId,
  T0,
} from '../../../../contract/testing/index.ts';
import { type FerretsPorts, FerretsService } from '../../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';

const record = (id: string, state: FerretState): FerretRecord => ({
  format: 1,
  id: ferretId(id),
  name: id,
  role: 'lead',
  harness: 'claude-code',
  runner: 'tmux',
  folder: '/work',
  state,
  createdAt: T0,
  stateAt: T0,
});

/** The real service over the real registry; `summary.md` texts by ferret, as the daemon half's opaque read answers. */
function service(records: readonly FerretRecord[], texts: ReadonlyMap<string, string>) {
  const asked: FerretId[] = [];
  const ports: FerretsPorts = {
    now: () => T0,
    newId: () => ferretId('unused'),
    newName: () => 'unused',
    save: async () => {},
    saveTokens: async () => {},
    harness: () => new FakeHarness(),
    harnessKeys: () => ['claude-code'],
    runner: () => new FakeRunner(),
    decide: async () => ({ allow: true }),
    launchParts: () => [],
    sitrepSources: () => [],
    instructions: () => [],
    folder: path => ok(fenced(path)),
    changed: () => {},
    summaryText: async ferret => {
      asked.push(ferret);
      return texts.get(ferret);
    },
    vault: { childEnvironment: async () => ok(emptyChildEnvironment()) },
    asks: { open: async () => [] },
  };
  return { asked, service: new FerretsService(new FerretRegistry(records), new FerretTokenDirectory(), ports) };
}

test('R-0170 FerretsService.summary reads a FINISHED ferret’s summary.md; an unknown or unfinished ferret has none', async () => {
  const texts = new Map([
    ['done', 'Fixed the bug.\n'],
    ['revived', 'The previous turn’s report.\n'],
    ['quiet', ''],
  ]);
  const { asked, service: ferrets } = service(
    [record('done', 'stopped'), record('revived', 'working'), record('idle', 'idle'), record('quiet', 'stopped')],
    texts,
  );

  expect(await ferrets.summary(ferretId('done'))).toBe('Fixed the bug.\n');
  expect(await ferrets.summary(ferretId('quiet'))).toBe('');
  // A ferret that was revived works on: its previous `summary.md` is not handed back as current.
  expect(await ferrets.summary(ferretId('revived'))).toBeUndefined();
  expect(await ferrets.summary(ferretId('idle'))).toBeUndefined();
  expect(await ferrets.summary(ferretId('nobody'))).toBeUndefined();
  // Only the finished ferrets' files are read at all; the id is checked before any read.
  expect(asked).toEqual([ferretId('done'), ferretId('quiet')]);
});

test('R-0170 FerretsService.summary answers nothing for a finished ferret that wrote no summary.md', async () => {
  const { service: ferrets } = service([record('done', 'stopped')], new Map());
  expect(await ferrets.summary(ferretId('done'))).toBeUndefined();
});
