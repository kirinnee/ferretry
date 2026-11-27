import { PERSON_ORIGIN } from '../../../../contract/index.ts';
import { describe, expect, test } from 'bun:test';
import { withRuntimeModel } from '../../../../daemon/lib/ferrets/runtime-records.ts';
import { ok } from '@ferretry/std';
import type { RunnerHandle, StartRequest } from '../../../../contract/index.ts';
import {
  emptyChildEnvironment,
  FakeHarness,
  FakeRunner,
  fakeThirdHarness,
  fenced,
  ferretId,
  harnessConformance,
  sampleLaunchSpec,
  T0,
  THIRD_HARNESS_FACTS,
  THIRD_HARNESS_KEY,
} from '../../../../contract/testing/index.ts';
import { FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';
import { ferretsPort } from '../../../../daemon/lib/ferrets/port.ts';

/**
 * The harness seam is OPEN (runtimes plan U4a): a harness the contract has never named (`fake-third`) boots, starts,
 * delivers and reads a transcript through the same Ferrets service as Claude Code and Codex, with no edit to it. The
 * fake plugs in exactly where a real third plugin will: the `harnesses` providers the daemon reads its registry from.
 * Fixture values only.
 */

harnessConformance('fake third harness (a key the contract never named)', () => {
  const harness = fakeThirdHarness('/home/agent-homes');
  return {
    harness,
    runner: new FakeRunner(),
    spec: sampleLaunchSpec(THIRD_HARNESS_KEY),
    deliveredCount: id => harness.delivered.filter(message => message.id === id).length,
  };
});

function fixture() {
  const registry = new FerretRegistry([]);
  const tokens = new FerretTokenDirectory();
  const runner = new FakeRunner();
  const claude = new FakeHarness('claude-code', '/fixture-fy/state/claude-code/agent-homes');
  const codex = new FakeHarness('codex', '/fixture-fy/state/codex/agent-homes');
  const third = fakeThirdHarness('/fixture-fy/state/fake-third/agent-homes');
  const installed = new Map<string, FakeHarness>([
    ['claude-code', claude],
    ['codex', codex],
    [THIRD_HARNESS_KEY, third],
  ]);
  const ports: FerretsPorts = {
    now: () => T0,
    newId: () => ferretId('third-one'),
    newName: taken => {
      for (let n = 1; ; n += 1) if (!taken(`fern${n}`)) return `fern${n}`;
    },
    save: async () => {},
    saveTokens: async () => {},
    harness: key => installed.get(key),
    harnessKeys: () => [...installed.keys()],
    runner: () => runner,
    decide: async () => ({ allow: true }),
    launchParts: () => [],
    sitrepSources: () => [],
    instructions: () => [],
    folder: path => ok(fenced(path)),
    changed: () => {},
    vault: { childEnvironment: async () => ok(emptyChildEnvironment()) },
    asks: { open: async () => [] },
  };
  return { registry, runner, claude, codex, third, service: new FerretsService(registry, tokens, ports) };
}

describe('a harness the contract never named', () => {
  test('projects only the registered harness runtime descriptor through FerretsPort', async () => {
    const f = fixture();
    const runtime = {
      binary: 'third',
      homeEnv: { THIRD_HOME: '' },
      detect: () => f.third.discover(),
      models: async () => ({ choices: [] }),
    };
    Object.assign(f.third, { runtime });
    const port = ferretsPort(f.service, 'runtimes');
    expect(port.harnessRuntime?.(THIRD_HARNESS_KEY)).toBe(runtime);
    expect(port.harnessRuntime?.('claude-code')).toBeUndefined();
    expect(port.harnessRuntime?.('unknown')).toBeUndefined();
    expect(await port.harnessRuntime?.(THIRD_HARNESS_KEY)?.models('fixture')).toEqual({ choices: [] });
  });
  test('is in the registry, and says what it is as data through the one facts port', () => {
    const f = fixture();

    expect(f.service.harnesses()).toEqual(['claude-code', 'codex', THIRD_HARNESS_KEY]);
    expect(f.service.harnessFacts(THIRD_HARNESS_KEY)).toEqual(THIRD_HARNESS_FACTS);
    expect(f.service.harnessFacts(THIRD_HARNESS_KEY)?.instructionFile).toBe('THIRD.md');
  });

  test('reports an Auto check only when the installed harness supplies the member, for any key', () => {
    const f = fixture();
    const port = ferretsPort(f.service, 'runtimes');
    let calls = 0;
    const autoLaunchRefusal = async () => {
      calls++;
      return undefined;
    };
    expect(port.harnessFacts('claude-code')?.checksAutoLaunch).toBeUndefined();
    expect(port.harnessFacts('codex')?.checksAutoLaunch).toBeUndefined();
    expect(port.harnessFacts(THIRD_HARNESS_KEY)?.checksAutoLaunch).toBeUndefined();
    Object.assign(f.third, { autoLaunchRefusal });
    expect(port.harnessFacts(THIRD_HARNESS_KEY)?.checksAutoLaunch).toBe(true);
    expect(calls).toBe(0);
    Object.assign(f.third, { autoLaunchRefusal: undefined });
    expect(port.harnessFacts(THIRD_HARNESS_KEY)?.checksAutoLaunch).toBeUndefined();
  });

  test('starts a ferret that is recorded on it, launched on it and on no other harness', async () => {
    const f = fixture();

    const started = await f.service.start({ folder: '/work', by: 'owner', harness: THIRD_HARNESS_KEY }, PERSON_ORIGIN);

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(f.registry.get(started.value)?.harness).toBe(THIRD_HARNESS_KEY);
    expect(f.third.launched.map(spec => spec.harness)).toEqual([THIRD_HARNESS_KEY]);
    expect(f.third.prepared).toHaveLength(1);
    expect(f.claude.launched).toEqual([]);
    expect(f.codex.launched).toEqual([]);
    expect(f.runner.starts).toBe(1);
  });

  test('takes a message once however often it is sent, and its transcript reads back', async () => {
    const f = fixture();
    const started = await f.service.start({ folder: '/work', by: 'owner', harness: THIRD_HARNESS_KEY }, PERSON_ORIGIN);
    if (!started.ok) throw new Error('start refused');
    const harness = f.third;
    const handle = 'h-1' as RunnerHandle;

    const message = { id: 'm-1', text: 'hello third' };
    await harness.deliver(started.value, handle, message);
    await harness.deliver(started.value, handle, message);
    f.third.entries = [{ id: 'e-1', at: T0, role: 'assistant', text: 'hello back' }];

    expect(f.third.delivered).toEqual([message]);
    expect(await harness.transcript.read()).toEqual([{ id: 'e-1', at: T0, role: 'assistant', text: 'hello back' }]);
  });

  test('a well-shaped key no installed plugin declares is refused by name, and starts nothing', async () => {
    const f = fixture();

    const answer = await f.service.start({ folder: '/work', by: 'owner', harness: 'gemini' }, PERSON_ORIGIN);

    expect(answer).toEqual({
      ok: false,
      error: { code: 'harness_not_installed', reason: 'no harness gemini is installed on this machine' },
    });
    expect(f.runner.starts).toBe(0);
    expect(f.service.harnessFacts('gemini')).toBeUndefined();
  });
});

const request: StartRequest = { folder: '/work', by: 'owner' };

test("a start records the runtime's selected model, unless there is none or the caller chose one", () => {
  expect(withRuntimeModel(request, 'provider/model')).toEqual({ ...request, options: { model: 'provider/model' } });
  expect(withRuntimeModel({ ...request, options: { effort: 'high' } } as StartRequest, 'provider/model')).toEqual({
    ...request,
    options: { effort: 'high', model: 'provider/model' },
  });
  expect(withRuntimeModel(request, undefined)).toBe(request);
  const chosen = { ...request, options: { model: 'caller/model' } } as StartRequest;
  expect(withRuntimeModel(chosen, 'provider/model')).toBe(chosen);
});
