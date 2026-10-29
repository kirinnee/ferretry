import '../support/dom.ts';
import { afterEach, describe, expect, it } from 'bun:test';
import type { IoPressureView } from '@ferretry/protocol';
import type { FyApiClient } from '@ferretry/protocol/client';
import type { z } from 'zod';
import { DiskPressureNote } from '../../src/components/disk-pressure-note.tsx';
import { DaemonClientProvider } from '../../src/lib/store.tsx';
import { useDiskPressure } from '../../src/lib/use-disk-pressure.ts';
import { type Mounted, mount } from '../support/dom.ts';
import { healthOf } from '../support/health.ts';
import { runAsync } from '../support/react.ts';
import { settleUntil } from '../support/settle.ts';
import { alpha } from './features/config-files/config-files-support.ts';

const SATURATED: IoPressureView = { someAvg10: 52, fullAvg10: 46, saturated: true };

let shown: Mounted | null = null;
afterEach(async () => {
  await shown?.unmount();
  shown = null;
});

function Probe({ daemon }: { readonly daemon: typeof alpha | undefined }) {
  const io = useDiskPressure(daemon);
  return <span data-io={io === undefined ? 'none' : String(io.fullAvg10)} />;
}

const seen = (): string | null | undefined => shown?.container.querySelector('span')?.getAttribute('data-io');

/** A machine whose answers are scripted in order, the last one repeating; an `Error` is a failed read. */
const scripted = (answers: ReadonlyArray<IoPressureView | undefined | Error>) => {
  let calls = 0;
  const client = {
    request: async (_path: string, schema: z.ZodType<unknown>) => {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      if (answer instanceof Error) throw answer;
      return schema.parse({ ...healthOf('4.101.0'), ...(answer === undefined ? {} : { io: answer }) });
    },
  } as unknown as FyApiClient;
  return { calls: () => calls, factory: async () => client };
};

describe('DiskPressureNote', () => {
  it('says the disk is saturated in plain words', async () => {
    shown = await mount(<DiskPressureNote io={SATURATED} />);
    const note = shown.container.querySelector('[data-disk-pressure]');
    expect(note?.textContent).toBe('Disk is saturated (io pressure 46% full) — the daemon is slow, not dead');
    expect(note?.getAttribute('role')).toBe('status');
  });
});

describe('useDiskPressure', () => {
  it('reports a saturated disk and nothing without a machine', async () => {
    shown = await mount(
      <DaemonClientProvider client={scripted([SATURATED]).factory}>
        <Probe daemon={alpha} />
      </DaemonClientProvider>,
    );
    await settleUntil(() => seen() === '46', 'the saturated disk to be reported', runAsync);
    await shown.unmount();
    shown = await mount(
      <DaemonClientProvider client={scripted([SATURATED]).factory}>
        <Probe daemon={undefined} />
      </DaemonClientProvider>,
    );
    expect(seen()).toBe('none');
  });

  it('keeps saying it through a read that fails, and stops once the machine says the disk is calm', async () => {
    const machine = scripted([SATURATED, new Error('timed out'), { someAvg10: 1, saturated: false }]);
    shown = await mount(
      <DaemonClientProvider client={machine.factory}>
        <Probe daemon={alpha} />
      </DaemonClientProvider>,
    );
    await settleUntil(() => seen() === '46', 'the saturated disk to be reported', runAsync);
    await runAsync(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settleUntil(() => machine.calls() === 2, 'the failing read', runAsync);
    expect(seen()).toBe('46');
    await runAsync(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settleUntil(() => seen() === 'none', 'the calm disk to be reported', runAsync);
  });
});
