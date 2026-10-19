import '../../../support/dom.ts';
import { afterEach, describe, expect, it } from 'bun:test';
import type { FyApiClient } from '@ferretry/protocol/client';
import type { z } from 'zod';
import {
  type MachineVoiceCleanup,
  useMachineVoiceCleanup,
  type VoiceCleanupSave,
} from '../../../../src/features/settings/use-machine-voice-cleanup.ts';
import type { DaemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { DaemonClientProvider } from '../../../../src/lib/store.tsx';
import { type Mounted, mount } from '../../../support/dom.ts';
import { runAsync } from '../../../support/react.ts';
import { settleUntil } from '../../../support/settle.ts';
import { alpha, fileView } from '../config-files/config-files-support.ts';

interface Wire {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

interface Fake {
  readonly wire: Wire[];
  readonly factory: (daemon: DaemonConnection) => Promise<FyApiClient>;
}

/** Serves `voice.yaml` text and answers a write with `put`; every call is recorded. */
const fake = (
  text: string | (() => string),
  put: () => unknown = () => ({ path: 'voice.yaml', etag: 'e2', outcome: 'applied' }),
): Fake => {
  const wire: Wire[] = [];
  const client = {
    request: async (path: string, schema: z.ZodType<unknown>, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      wire.push({ method, path, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
      if (method === 'PUT') return schema.parse(put());
      return schema.parse(
        fileView({
          path: 'voice.yaml',
          kind: 'voice',
          schema: 'voice',
          text: typeof text === 'function' ? text() : text,
          etag: 'e1',
        }),
      );
    },
  } as unknown as FyApiClient;
  return { wire, factory: async () => client };
};

let shown: Mounted | null = null;
let latest: MachineVoiceCleanup | null = null;

afterEach(async () => {
  await shown?.unmount();
  shown = null;
  latest = null;
});

function Probe({ daemon }: { readonly daemon: DaemonConnection | undefined }) {
  latest = useMachineVoiceCleanup(daemon);
  return <span data-style={latest.cleanup.style} data-loaded={String(latest.loaded)} />;
}

const mounted = async (daemon: DaemonConnection | undefined, factory: Fake['factory']): Promise<void> => {
  shown = await mount(
    <DaemonClientProvider client={factory}>
      <Probe daemon={daemon} />
    </DaemonClientProvider>,
  );
};

const attr = (name: string): string | null | undefined => shown?.container.querySelector('span')?.getAttribute(name);

const saveWith = async (patch: Parameters<MachineVoiceCleanup['save']>[0]): Promise<VoiceCleanupSave> => {
  let result: VoiceCleanupSave | null = null;
  await runAsync(async () => {
    result = (await latest?.save(patch)) ?? null;
  });
  if (result === null) throw new Error('no save result');
  return result;
};

describe('useMachineVoiceCleanup', () => {
  it('reads nothing without a machine and refuses a save', async () => {
    const served = fake('');
    await mounted(undefined, served.factory);
    expect(attr('data-loaded')).toBe('false');
    expect(served.wire).toEqual([]);
    expect((await saveWith({ style: 'off' })).kind).toBe('refused');
  });

  it('reads the machine’s cleanup settings', async () => {
    const served = fake('postProcessing:\n  style: polish\n');
    await mounted(alpha, served.factory);
    await settleUntil(() => attr('data-loaded') === 'true', 'the file to be read', runAsync);
    expect(attr('data-style')).toBe('polish');
  });

  it('shows the defaults, unloaded, when the file cannot be read', async () => {
    const served = fake(() => {
      throw new Error('unreachable');
    });
    await mounted(alpha, served.factory);
    await settleUntil(() => served.wire.length === 1, 'the read to be tried', runAsync);
    expect(attr('data-loaded')).toBe('false');
    expect(attr('data-style')).toBe('fix');
  });

  it('writes an edit against the etag it just read and shows the result', async () => {
    const served = fake('postProcessing:\n  style: fix\n');
    await mounted(alpha, served.factory);
    await settleUntil(() => attr('data-loaded') === 'true', 'the file to be read', runAsync);
    expect(await saveWith({ style: 'polish' })).toEqual({ kind: 'applied' });
    const put = served.wire.find(call => call.method === 'PUT');
    expect(put?.path).toBe('/v1/config/file');
    expect(JSON.stringify(put?.body)).toContain('style: polish');
    expect(attr('data-style')).toBe('polish');
  });

  it('says so when the daemon holds the edit for the owner to confirm', async () => {
    const served = fake('', () => ({
      path: 'voice.yaml',
      etag: 'e2',
      outcome: 'pending',
      pending: { path: 'voice.yaml', etag: 'e2', changes: ['conversation messages may now go out'] },
    }));
    await mounted(alpha, served.factory);
    const result = await saveWith({ useConversation: true });
    expect(result.kind).toBe('pending');
    expect('message' in result && result.message).toContain('conversation messages may now go out');
  });

  it('refuses, in words, a file that does not check', async () => {
    const served = fake('postProcessing:\n  style: shout\n');
    await mounted(alpha, served.factory);
    const result = await saveWith({ style: 'fix' });
    expect(result.kind).toBe('refused');
    expect(served.wire.some(call => call.method === 'PUT')).toBe(false);
  });

  it('refuses, in words, a write the daemon rejects', async () => {
    const served = fake('', () => {
      throw new Error('boom');
    });
    await mounted(alpha, served.factory);
    expect((await saveWith({ style: 'off' })).kind).toBe('refused');
  });

  it('reports a held edit even when the daemon names no changes', async () => {
    const served = fake('', () => ({ path: 'voice.yaml', etag: 'e2', outcome: 'pending' }));
    await mounted(alpha, served.factory);
    expect((await saveWith({ style: 'off' })).kind).toBe('pending');
  });
});
