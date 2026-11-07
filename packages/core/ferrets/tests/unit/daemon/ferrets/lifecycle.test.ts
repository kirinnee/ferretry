import { expect, test } from 'bun:test';
import { ok } from '@ferretry/std';
import type { FerretRecord } from '../../../../contract/index.ts';
import {
  FakeHarness,
  FakeRunner,
  ferretId,
  fenced,
  T0,
  emptyChildEnvironment,
} from '../../../../contract/testing/index.ts';
import { FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';

function fixture() {
  const id = ferretId('fern');
  const record: FerretRecord = {
    format: 1,
    id,
    name: 'fern',
    role: 'lead',
    harness: 'claude-code',
    runner: 'tmux',
    folder: '/work',
    state: 'stopped',
    createdAt: T0,
    stateAt: T0,
  };
  const registry = new FerretRegistry([record]);
  const tokens = new FerretTokenDirectory();
  const runner = new FakeRunner();
  const harness = new FakeHarness();
  const ports: FerretsPorts = {
    now: () => T0,
    newId: () => id,
    newName: () => 'fern',
    save: async () => {},
    saveTokens: async () => {},
    harness: () => harness,
    harnessKeys: () => ['claude-code'],
    runner: () => runner,
    decide: async () => ({ allow: true }),
    launchParts: () => [],
    sitrepSources: () => [],
    instructions: () => [],
    home: () => fenced('/homes/fern'),
    folder: path => ok(fenced(path)),
    changed: () => {},
    vault: { childEnvironment: async () => ok(emptyChildEnvironment()) },
    asks: { open: async () => [] },
  };
  return { id, registry, tokens, runner, harness, ports, service: new FerretsService(registry, tokens, ports) };
}

test('R-0363 concurrent resumes share the lifecycle gate and launch once', async () => {
  const f = fixture();
  const answers = await Promise.all([f.service.resume(f.id), f.service.resume(f.id)]);
  expect(answers.every(answer => answer.ok)).toBe(true);
  expect(f.runner.starts).toBe(1);
  expect(await f.runner.alive((await f.service.handle(f.id))!)).toBe(true);
});

test('R-0363 stop waits for an in-flight resume then terminates its process', async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  let entered!: () => void;
  const deciding = new Promise<void>(resolve => {
    entered = resolve;
  });
  f.ports.decide = async () => {
    entered();
    await held;
    return { allow: true };
  };
  const resuming = f.service.resume(f.id);
  await deciding;
  const stopping = f.service.stop(f.id, 'now');
  release();
  await Promise.all([resuming, stopping]);
  expect(f.registry.get(f.id)?.state).toBe('stopped');
  expect(await f.runner.alive('%1' as never)).toBe(false);
  expect(f.tokens.holds(f.id)).toBe(false);
});
