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
  const answer = await (port.resume as unknown as (...args: unknown[]) => Promise<{ ok: boolean; error?: unknown }>)(
    f.id,
    undefined,
    sneaky,
  );
  // Only the Warden replaces a live pane: for any other consumer it is a refusal, and nothing is resumed.
  expect(answer).toEqual({ ok: false, error: { code: 'refused', reason: 'only the Warden replaces a live pane' } });
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
      'adoptTitle',
      'agentControl',
      'attach',
      'children',
      'compactAt',
      'effectiveLimits',
      'exclusive',
      'get',
      'handle',
      'harness',
      'harnesses',
      'importConversation',
      'historySources',
      'lastSnapshot',
      'list',
      'managedWorktrees',
      'markStalled',
      'mayTouch',
      'move',
      'prompt',
      'repointRuntime',
      'resolve',
      'resume',
      'runtimeRecords',
      'setCompactAt',
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

test('resolve answers an id or a callsign (any case, with the composer’s colon) with the one ferret it names', async () => {
  const f = additivesFixture();
  const port = ferretsPort(f.service, 'conversation');
  const name = f.registry.get(f.id)!.name;

  expect(await port.resolve(f.id)).toEqual({ kind: 'ferret', id: f.id });
  expect(await port.resolve(name)).toEqual({ kind: 'ferret', id: f.id });
  expect(await port.resolve(`:${name.toUpperCase()}`)).toEqual({ kind: 'ferret', id: f.id });
  expect(await port.resolve('nobody-has-this-name')).toEqual({ kind: 'unknown' });
});

test('historySources lists each harness that answered (an empty answer too), and a harness that throws is left out', async () => {
  const f = additivesFixture();
  const files = { entries: async () => [], stat: async () => undefined, read: async () => undefined };
  const source = { kind: 'computer', label: 'owner', files } as const;
  const harnesses: Record<string, unknown> = {
    'claude-code': { historySources: async () => [source] },
    gone: { historySources: async () => Promise.reject(new Error('gone')) },
    codex: { historySources: async () => [] },
    plain: {},
  };
  (f.service as unknown as { ports: Record<string, unknown> }).ports = {
    ...(f.service as unknown as { ports: Record<string, unknown> }).ports,
    harnessKeys: () => Object.keys(harnesses),
    harness: (key: string) => harnesses[key],
  };
  const port = ferretsPort(f.service, 'conversation');
  expect(await port.historySources?.()).toEqual([
    { harness: 'claude-code', sources: [source] },
    { harness: 'codex', sources: [] },
  ]);
});

test('only Conversation can import a transcript, and only id/source are forwarded in a fresh request', async () => {
  const seen: { harness: string; input: unknown }[] = [];
  const service = {
    importConversation: async (harness: string, input: unknown) => {
      seen.push({ harness, input });
      return { ok: true, value: undefined };
    },
  };
  const denied = ferretsPort(service as never, 'board').importConversation;
  if (denied === undefined) throw new Error('the import boundary is missing');
  await expect(denied('claude-code', { id: 'c1', source: 'projects/p/c1.jsonl' })).rejects.toThrow(
    'only the Conversation plugin',
  );
  expect(seen).toEqual([]);
  const allowed = ferretsPort(service as never, 'conversation').importConversation;
  if (allowed === undefined) throw new Error('the import boundary is missing');
  const request = { id: 'c1', source: 'projects/p/c1.jsonl', credential: 'must-not-be-forwarded' };
  expect(await allowed('claude-code', request)).toEqual({ ok: true, value: undefined });
  expect(seen).toEqual([{ harness: 'claude-code', input: { id: 'c1', source: 'projects/p/c1.jsonl' } }]);
  expect(seen[0]?.input).not.toBe(request);
});

test('a shared copy delegates to its harness and reports unavailable, unsupported and failed imports without leaking an exception', async () => {
  const f = additivesFixture();
  const input = { id: 'c1', source: 'projects/p/c1.jsonl' };
  const seen: unknown[] = [];
  const harnesses: Record<string, unknown> = {
    'claude-code': {
      importConversation: async (request: unknown) => {
        seen.push(request);
        return { ok: true, value: undefined };
      },
    },
  };
  (f.service as unknown as { ports: Record<string, unknown> }).ports = {
    ...(f.service as unknown as { ports: Record<string, unknown> }).ports,
    harness: (key: string) => harnesses[key],
  };
  const copy = ferretsPort(f.service, 'conversation').importConversation;
  if (copy === undefined) throw new Error('the import boundary is missing');
  expect(await copy('codex', input)).toEqual({
    ok: false,
    error: { reason: 'The codex harness is off, so its conversation cannot be copied.' },
  });
  harnesses.codex = {};
  expect(await copy('codex', input)).toEqual({
    ok: false,
    error: { reason: 'The codex harness keeps no shared copy of a conversation.' },
  });
  harnesses.codex = {
    importConversation: async () => {
      throw new Error('private failure detail');
    },
  };
  expect(await copy('codex', input)).toEqual({
    ok: false,
    error: { reason: 'The conversation could not be copied.' },
  });
  harnesses.codex = { importConversation: async () => ({ ok: false, error: { reason: 'the transcript is absent' } }) };
  expect(await copy('codex', input)).toEqual({ ok: false, error: { reason: 'the transcript is absent' } });
  expect(await copy('claude-code', input)).toEqual({ ok: true, value: undefined });
  expect(seen).toEqual([input]);
});
