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

test('R-0372 unavailable stop keeps its live handle and token and answers 503', async () => {
  for (const missing of ['harness', 'runner'] as const) {
    const f = fixture();
    await f.service.resume(f.id);
    const handle = await f.service.handle(f.id);
    f.ports[missing] = () => undefined;
    await expect(f.service.stop(f.id, 'now')).rejects.toMatchObject({ status: 503 });
    expect(await f.service.handle(f.id)).toBe(handle);
    expect(f.registry.get(f.id)?.state).toBe('working');
    expect(f.tokens.holds(f.id)).toBe(true);
    expect(await f.runner.alive(handle!)).toBe(true);
  }
});

test('R-0332 thrown launch ports revoke the token and allow a later resume', async () => {
  for (const port of ['environment', 'harness', 'save'] as const) {
    const f = fixture();
    const originalStart = f.harness.start.bind(f.harness);
    if (port === 'environment')
      f.ports.vault.childEnvironment = async () => {
        throw new Error('unavailable');
      };
    if (port === 'harness')
      f.harness.start = async () => {
        throw new Error('unavailable');
      };
    if (port === 'save')
      f.ports.save = async record => {
        if (record.state === 'working') throw new Error('unavailable');
      };
    const answer = await f.service.resume(f.id).catch(() => undefined);
    expect(answer?.ok).toBe(false);
    expect(f.registry.get(f.id)?.state).toBe('stopped');
    expect(f.tokens.holds(f.id)).toBe(false);
    expect(await f.runner.alive('%1' as never)).toBe(false);
    f.ports.vault.childEnvironment = async () => ok(emptyChildEnvironment());
    f.harness.start = originalStart;
    f.ports.save = async () => {};
    expect((await f.service.resume(f.id)).ok).toBe(true);
  }
});
test('R-0332 a harness throwing after runner.start cleans up the created process', async () => {
  const f = fixture();
  const start = f.harness.start.bind(f.harness);
  f.harness.start = async (...args) => {
    await start(...args);
    throw new Error('harness failed after spawn');
  };
  const answer = await f.service.resume(f.id).catch(() => undefined);
  expect(answer?.ok).toBe(false);
  expect(await f.runner.alive('%1' as never)).toBe(false);
  expect(f.tokens.holds(f.id)).toBe(false);
  expect(f.registry.get(f.id)?.state).toBe('stopped');
});

test('R-0363 owner cutoff survives reload and an unconfirmed port resume cannot restore it', async () => {
  const f = fixture();
  await f.service.resume(f.id);
  await f.service.revokeToken(f.id);
  await f.service.stop(f.id, 'now');
  const tokens = new FerretTokenDirectory(f.tokens.snapshot());
  const service = new FerretsService(f.registry, tokens, f.ports);
  const answer = await service.resume(f.id);
  expect(answer.ok).toBe(false);
  expect(tokens.isCutOff(f.id)).toBe(true);
  expect(tokens.holds(f.id)).toBe(false);
  expect(f.runner.starts).toBe(1);
});

test('R-0363 confirmed restoration is checked before rotation and failed restores re-mark cutoff', async () => {
  const f = fixture();
  await f.service.resume(f.id);
  await f.service.revokeToken(f.id);
  await f.service.stop(f.id, 'now');
  let confirmed = 0;
  f.ports.decide = async () => ({ allow: false, reason: 'admission refused' });
  const refused = await f.service.resume(f.id, undefined, () => {
    confirmed++;
  });
  expect(refused.ok).toBe(false);
  expect(confirmed).toBe(1);
  expect(f.tokens.isCutOff(f.id)).toBe(true);
  f.ports.decide = async () => ({ allow: true });
  const resumed = await f.service.resume(f.id, undefined, () => {
    expect(f.tokens.holds(f.id)).toBe(false);
    expect(f.tokens.isCutOff(f.id)).toBe(true);
    confirmed++;
  });
  expect(resumed.ok).toBe(true);
  expect(confirmed).toBe(2);
  expect(f.tokens.isCutOff(f.id)).toBe(false);
  expect(f.tokens.holds(f.id)).toBe(true);
});

test('R-0363 a denied restoration or damaged credential state cannot launch or issue a token', async () => {
  const f = fixture();
  await f.service.resume(f.id);
  await f.service.revokeToken(f.id);
  await f.service.stop(f.id, 'now');
  await expect(
    f.service.resume(f.id, undefined, () => {
      throw new Error('owner only');
    }),
  ).rejects.toThrow('owner only');
  expect(f.tokens.isCutOff(f.id)).toBe(true);
  f.tokens.unavailable();
  await expect(f.service.resume(f.id, undefined, () => {})).rejects.toMatchObject({ status: 503 });
  expect(f.tokens.holds(f.id)).toBe(false);
  expect(f.runner.starts).toBe(1);
});
