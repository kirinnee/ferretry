import { PERSON_ORIGIN } from '../../../../contract/index.ts';
import { expect, test } from 'bun:test';
import type { LimitsFile } from '../../../../contract/index.ts';
import { ferretsPort } from '../../../../daemon/lib/ferrets/port.ts';
import { additivesFixture } from './additives-fixture.ts';

test('through the port, a live ferret keeps its pane and runtime even when a plugin passes the move’s options anyway', async () => {
  const f = additivesFixture();
  await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });
  const before = (await f.service.handle(f.id))!;
  const port = ferretsPort(f.service, 'board');
  // A plugin that builds or spreads the options at runtime gets past the types; the port drops what is not its own.
  const sneaky = {
    origin: PERSON_ORIGIN,
    replaceLiveTerminal: true,
    target: { runtime: 'codex-two', harness: 'codex' },
  };
  const answer = await (port.resume as unknown as (...args: unknown[]) => Promise<{ ok: boolean }>)(
    f.id,
    undefined,
    sneaky,
  );
  expect(answer.ok).toBe(true);
  expect(await f.service.handle(f.id)).toBe(before);
  expect(await f.runner.alive(before)).toBe(true);
  expect(f.runner.starts).toBe(1);
  expect(f.registry.get(f.id)?.runtime).toBeUndefined();
  expect(f.registry.get(f.id)?.harness).toBe('claude-code');
});

test('KCB-F effectiveLimits answers limits.yaml as in effect, read fresh', async () => {
  let file: LimitsFile = { enabled: true, perFerret: { memoryMax: '512M' } };
  let reads = 0;
  const f = additivesFixture({
    limits: () => {
      reads += 1;
      return file;
    },
  });
  const port = ferretsPort(f.service, 'terminals');

  expect(await port.effectiveLimits!()).toEqual({ enabled: true, perFerret: { memoryMax: '512M' } });
  file = { enabled: false };
  expect(await port.effectiveLimits!()).toEqual({ enabled: false });
  expect(reads).toBe(2);

  // No limits port bound (or nothing answered): the empty file, so the defaults.
  expect(await ferretsPort(additivesFixture().service, 'terminals').effectiveLimits!()).toEqual({});
  expect(
    await ferretsPort(additivesFixture({ limits: () => undefined }).service, 'terminals').effectiveLimits!(),
  ).toEqual({});
});

test('through the port, automatic still reaches a stopped ferret’s resume, and the service’s other methods are bound', async () => {
  const f = additivesFixture();
  const port = ferretsPort(f.service, 'board');
  expect((await port.resume(f.id, undefined, { origin: PERSON_ORIGIN, automatic: true })).ok).toBe(true);
  expect(f.history.at(-1)).toMatchObject({ type: 'session.resumed', data: { automatic: true } });
  expect((await port.get(f.id))?.id).toBe(f.id);
});

test('M3 through the port, the callbacks a resume may carry reach the service, and nothing else does', async () => {
  const seen: unknown[] = [];
  const port = ferretsPort(
    {
      resume: async (_ferret: unknown, _message: unknown, options: unknown) => {
        seen.push(options);
        return { ok: true, value: 'f1' };
      },
    } as never,
    'board',
  );
  const decided = () => undefined;
  const onCarried = () => undefined;

  await (port.resume as unknown as (...args: unknown[]) => Promise<unknown>)('f1', 'hi', {
    origin: PERSON_ORIGIN,
    decided,
    onCarried,
    confirmRestore: () => undefined,
  });
  await port.resume('f1' as never, 'hi', { origin: PERSON_ORIGIN });

  expect(seen).toEqual([{ origin: PERSON_ORIGIN, decided, onCarried }, { origin: PERSON_ORIGIN }]);
});

test('through the port, stop’s 4th cause argument is ignored: a plugin cannot stamp an end cause', async () => {
  const f = additivesFixture();
  await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });
  const port = ferretsPort(f.service, 'board') as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  await port.stop!(f.id, 'now', 'x', { kind: 'completed' });
  expect(f.registry.get(f.id)?.state).toBe('stopped');
  expect(f.registry.get(f.id)?.cause).toEqual({ kind: 'stopped' });
});

test('through the port, the service’s own members are not there: revokeToken, releaseLive, launch, tokens, rename', () => {
  const f = additivesFixture();
  const port = ferretsPort(f.service, 'board') as unknown as Record<string, unknown>;
  for (const name of ['revokeToken', 'releaseLive', 'retarget', 'launch', 'tokens', 'ports', 'rename', 'turnObserved'])
    expect(port[name]).toBeUndefined();
  // Exactly the FerretsApi members the service implements are there.
  expect(Object.keys(port).sort()).toEqual(
    [
      'agentControl',
      'attach',
      'children',
      'effectiveLimits',
      'get',
      'handle',
      'harness',
      'harnesses',
      'list',
      'managedWorktrees',
      'mayTouch',
      'move',
      'prompt',
      'resume',
      'sitrep',
      'start',
      'stop',
      'summary',
      'systemCallsign',
      'turnUsage',
      'turns',
      'workFolder',
    ].sort(),
  );
});
