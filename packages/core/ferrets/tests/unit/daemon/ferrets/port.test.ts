import { expect, test } from 'bun:test';
import { ferretsPort } from '../../../../daemon/lib/ferrets/port.ts';
import { additivesFixture } from './additives-fixture.ts';

test('through the port, a live ferret keeps its pane and runtime even when a plugin passes the move’s options anyway', async () => {
  const f = additivesFixture();
  await f.service.resume(f.id);
  const before = (await f.service.handle(f.id))!;
  const port = ferretsPort(f.service, 'board');
  // A plugin that builds or spreads the options at runtime gets past the types; the port drops what is not its own.
  const sneaky = { replaceLiveTerminal: true, target: { runtime: 'codex-two', harness: 'codex' } };
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

test('through the port, automatic still reaches a stopped ferret’s resume, and the service’s other methods are bound', async () => {
  const f = additivesFixture();
  const port = ferretsPort(f.service, 'board');
  expect((await port.resume(f.id, undefined, { automatic: true })).ok).toBe(true);
  expect(f.history.at(-1)).toMatchObject({ type: 'session.resumed', data: { automatic: true } });
  expect((await port.get(f.id))?.id).toBe(f.id);
});

test('through the port, stop’s 4th cause argument is ignored: a plugin cannot stamp an end cause', async () => {
  const f = additivesFixture();
  await f.service.resume(f.id);
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
      'turns',
      'workFolder',
    ].sort(),
  );
});
