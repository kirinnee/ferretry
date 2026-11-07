import '../../../../support/dom.ts';
import { afterEach, describe, expect, it } from 'bun:test';
import type { VoiceEngine } from '@ferretry/protocol';
import type { FyApiClient } from '@ferretry/protocol/client';
import type { z } from 'zod';
import {
  machineVoiceEngine,
  useMachineVoiceEngine,
  VOICE_FILE,
  withMachineVoiceEngine,
} from '../../../../../src/features/fleet/setup/voice-default.ts';
import { type DaemonConnection, daemonConnection } from '../../../../../src/lib/daemon-connection.ts';
import { DaemonClientProvider } from '../../../../../src/lib/store.tsx';
import { type Mounted, mount } from '../../../../support/dom.ts';
import { runAsync } from '../../../../support/react.ts';
import { settleUntil } from '../../../../support/settle.ts';
import { alpha, fileView } from '../../config-files/config-files-support.ts';
import { configChangeHarness } from '../../../config-change-support.tsx';

const beta = daemonConnection({
  daemonId: 'beta',
  baseUrl: 'https://beta.example.test',
  deviceId: 'fy_device_id_beta000000000000000000',
});

describe('machineVoiceEngine', () => {
  it.each<[string, string, VoiceEngine]>([
    ['parakeet', 'defaultEngine: parakeet\n', 'parakeet'],
    ['browser', 'defaultEngine: browser\n', 'browser'],
    ['a double-quoted value', 'defaultEngine: "parakeet"\n', 'parakeet'],
    ['a single-quoted value', "defaultEngine: 'browser'\n", 'browser'],
    ['a trailing comment', 'defaultEngine: parakeet   # the owner prefers it\n', 'parakeet'],
    ['no space after the colon', 'defaultEngine:browser\n', 'browser'],
    ['other keys around it', 'postProcessing:\n  provider: off\ndefaultEngine: browser\n# end\n', 'browser'],
  ])('reads %s', (_label, text, expected) => {
    expect(machineVoiceEngine(text)).toBe(expected);
  });

  it.each([
    ['an engine this app does not know', 'defaultEngine: whisper\n'],
    ['an empty value', 'defaultEngine:\n'],
    ['no such line', 'postProcessing:\n  provider: off\n'],
    ['an empty file', ''],
    ['an indented key, which is not the top-level one', 'postProcessing:\n  defaultEngine: parakeet\n'],
  ])('names no engine for %s', (_label, text) => {
    expect(machineVoiceEngine(text)).toBeNull();
  });
});

describe('withMachineVoiceEngine', () => {
  it('replaces the line where it is and keeps every other line and comment', () => {
    const text = '# voice\ndefaultEngine: browser   # old\npostProcessing:\n  provider: off\n';
    expect(withMachineVoiceEngine(text, 'parakeet')).toBe(
      '# voice\ndefaultEngine: parakeet\npostProcessing:\n  provider: off\n',
    );
  });

  it('adds the line at the end when the file names none', () => {
    expect(withMachineVoiceEngine('postProcessing:\n  provider: off\n', 'browser')).toBe(
      'postProcessing:\n  provider: off\ndefaultEngine: browser\n',
    );
  });

  it('adds a newline first when the file does not end with one', () => {
    expect(withMachineVoiceEngine('# voice', 'parakeet')).toBe('# voice\ndefaultEngine: parakeet\n');
  });

  it('writes just the line into an empty file', () => {
    expect(withMachineVoiceEngine('', 'browser')).toBe('defaultEngine: browser\n');
  });

  it('leaves an indented defaultEngine alone and adds the top-level one', () => {
    expect(withMachineVoiceEngine('postProcessing:\n  defaultEngine: x\n', 'browser')).toBe(
      'postProcessing:\n  defaultEngine: x\ndefaultEngine: browser\n',
    );
  });

  it('round-trips through the reader', () => {
    expect(machineVoiceEngine(withMachineVoiceEngine('# voice\n', 'parakeet'))).toBe('parakeet');
  });
});

interface Read {
  readonly daemonId: string;
  readonly path: string;
}

type Answer = (read: Read) => Promise<string> | string;

/** A typed client whose `voice.yaml` reads are answered by `answer`; every read is recorded. */
const fakeFactory = (answer: Answer, reads: Read[]) => {
  const client = (daemon: DaemonConnection) =>
    ({
      request: async (path: string, schema: z.ZodType<unknown>) => {
        const read = { daemonId: daemon.daemonId, path };
        reads.push(read);
        return schema.parse(fileView({ path: VOICE_FILE, kind: 'voice', schema: 'voice', text: await answer(read) }));
      },
    }) as unknown as FyApiClient;
  return async (daemon: DaemonConnection): Promise<FyApiClient> => client(daemon);
};

let shown: Mounted | null = null;

afterEach(async () => {
  await shown?.unmount();
  shown = null;
});

function Probe({ daemon }: { readonly daemon: DaemonConnection | undefined }) {
  return <span data-engine={String(useMachineVoiceEngine(daemon))} />;
}

const engineShown = (): string | null | undefined =>
  shown?.container.querySelector('[data-engine]')?.getAttribute('data-engine');

const probe = (daemon: DaemonConnection | undefined, factory: ReturnType<typeof fakeFactory>) => (
  <DaemonClientProvider client={factory}>
    <Probe daemon={daemon} />
  </DaemonClientProvider>
);

describe('useMachineVoiceEngine', () => {
  it('reads nothing and names no engine without a machine', async () => {
    const reads: Read[] = [];
    shown = await mount(
      probe(
        undefined,
        fakeFactory(() => 'defaultEngine: parakeet\n', reads),
      ),
    );
    expect(engineShown()).toBe('null');
    expect(reads).toEqual([]);
  });

  it("reads the machine's voice.yaml and returns the engine it names", async () => {
    const reads: Read[] = [];
    shown = await mount(
      probe(
        alpha,
        fakeFactory(() => 'defaultEngine: parakeet\n', reads),
      ),
    );
    await settleUntil(() => engineShown() === 'parakeet', 'the machine default to arrive', runAsync);
    expect(reads).toEqual([{ daemonId: 'alpha', path: '/v1/config/file?path=voice.yaml' }]);
  });

  it('names no engine when the file names none', async () => {
    const reads: Read[] = [];
    shown = await mount(
      probe(
        alpha,
        fakeFactory(() => 'postProcessing:\n  provider: off\n', reads),
      ),
    );
    await settleUntil(() => reads.length === 1, 'the file to be read', runAsync);
    expect(engineShown()).toBe('null');
  });

  it('names no engine when the read fails', async () => {
    const reads: Read[] = [];
    const failing = fakeFactory(() => {
      throw new Error('the daemon is unreachable');
    }, reads);
    shown = await mount(probe(alpha, failing));
    await settleUntil(() => reads.length === 1, 'the failing read to be attempted', runAsync);
    expect(engineShown()).toBe('null');
  });

  it('names no engine when no client can be made', async () => {
    shown = await mount(
      <DaemonClientProvider
        client={async () => {
          throw new Error('no client');
        }}
      >
        <Probe daemon={alpha} />
      </DaemonClientProvider>,
    );
    await runAsync(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(engineShown()).toBe('null');
  });

  it("shows no engine for a machine until that machine's own answer, and ignores the old machine's late one", async () => {
    const reads: Read[] = [];
    const releases = new Map<string, (text: string) => void>();
    const factory = fakeFactory(
      read =>
        new Promise<string>(resolve => {
          releases.set(read.daemonId, resolve);
        }),
      reads,
    );
    shown = await mount(probe(alpha, factory));
    await settleUntil(() => releases.has('alpha'), "alpha's read to start", runAsync);

    await runAsync(async () => {
      await shown?.render(probe(beta, factory));
    });
    await settleUntil(() => releases.has('beta'), "beta's read to start", runAsync);

    // alpha answers AFTER the switch: that answer is for a machine no longer shown.
    await runAsync(async () => {
      releases.get('alpha')?.('defaultEngine: browser\n');
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(engineShown()).toBe('null');

    await runAsync(async () => {
      releases.get('beta')?.('defaultEngine: parakeet\n');
    });
    await settleUntil(() => engineShown() === 'parakeet', "beta's own answer to arrive", runAsync);
  });

  it("drops a machine's answer when the machine is switched away from before it lands", async () => {
    const reads: Read[] = [];
    const factory = fakeFactory(read => (read.daemonId === 'alpha' ? 'defaultEngine: browser\n' : 'x: 1\n'), reads);
    shown = await mount(probe(alpha, factory));
    await settleUntil(() => engineShown() === 'browser', "alpha's default to arrive", runAsync);

    await runAsync(async () => {
      await shown?.render(probe(beta, factory));
    });
    await settleUntil(() => reads.length === 2, "beta's read", runAsync);
    expect(engineShown()).toBe('null');
  });

  it('reads voice.yaml again after the machine says its voice moved, and returns the new engine', async () => {
    // Arrange: a machine whose file names parakeet, shown on a screen under a live change store.
    const reads: Read[] = [];
    let text = 'defaultEngine: parakeet\n';
    const harness = configChangeHarness(alpha.daemonId);
    shown = await mount(
      harness.wrap(
        probe(
          alpha,
          fakeFactory(() => text, reads),
        ),
      ),
    );
    await settleUntil(() => engineShown() === 'parakeet', 'the machine default to arrive', runAsync);
    expect(reads).toHaveLength(1);

    // Act: a hand edit changes defaultEngine, and the machine reports its voice moved.
    text = 'defaultEngine: browser\n';
    await harness.move(['voice']);

    // Assert: the file is read again and the screen shows the new engine without a reload.
    await settleUntil(() => engineShown() === 'browser', 'the new machine default to arrive', runAsync);
    expect(reads).toHaveLength(2);
  });

  it('does not read again when only another kind of configuration moved', async () => {
    const reads: Read[] = [];
    const harness = configChangeHarness(alpha.daemonId);
    shown = await mount(
      harness.wrap(
        probe(
          alpha,
          fakeFactory(() => 'defaultEngine: parakeet\n', reads),
        ),
      ),
    );
    await settleUntil(() => engineShown() === 'parakeet', 'the machine default to arrive', runAsync);

    await harness.move(['runtimes']);

    expect(reads).toHaveLength(1);
    expect(engineShown()).toBe('parakeet');
  });

  it('works without a machine under a store provider, even when a change arrives', async () => {
    const reads: Read[] = [];
    const harness = configChangeHarness(alpha.daemonId);
    shown = await mount(
      harness.wrap(
        probe(
          undefined,
          fakeFactory(() => 'defaultEngine: parakeet\n', reads),
        ),
      ),
    );
    await harness.move(['voice']);
    expect(engineShown()).toBe('null');
    expect(reads).toEqual([]);
  });
});
