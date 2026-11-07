import { afterEach, describe, expect, it, mock } from 'bun:test';
import { FerretIdSchema } from '@ferretry/core-ferrets/contract';
import { InstantSchema } from '@ferretry/std';
import type { FerretPackPatchResult } from '../../../../../contract/index.ts';
import type { PacksClient } from '../../../../../app/lib/client.ts';
import { type Mounted, mount, must } from '../../../support/dom.ts';
import { click, waitFor, waitForText } from '../../../support/learning-dom.ts';
import { uiDoubles } from '../../../support/ui-doubles.tsx';

mock.module('../../../../../app/ui.ts', () => uiDoubles);
const { PackNote, PackSwitchRow, usePackFerretSwitch } = await import(
  '../../../../../app/features/pack/pack-ferret-switch.tsx'
);

interface Call {
  readonly key: string;
  readonly init: unknown;
}

const answer = (enabled: boolean): FerretPackPatchResult => ({
  ferret: {
    id: FerretIdSchema.parse('hadi-1'),
    name: 'hadi',
    role: 'lead',
    harness: 'claude-code',
    runner: 'tmux',
    folder: '/work',
    state: 'working',
    createdAt: InstantSchema.parse('2026-10-20T00:00:00.000Z'),
    stateAt: InstantSchema.parse('2026-10-20T00:00:01.000Z'),
  },
  restartRequired: true,
  note: `Pack mode is ${enabled ? 'on' : 'off'}. This ferret is running, so it takes effect when the ferret restarts.`,
});

function fakeDaemon() {
  const calls: Call[] = [];
  const refusals: unknown[] = [];
  const client = {
    call: async (key: string, init?: { body?: { enabled: boolean } }) => {
      calls.push({ key, init });
      const refusal = refusals.shift();
      if (refusal !== undefined) throw refusal;
      return answer(init?.body?.enabled ?? true);
    },
  } as unknown as PacksClient;
  return { calls, refusals, client };
}

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

function Page({ client }: { readonly client: PacksClient }) {
  const control = usePackFerretSwitch({ client });
  return (
    <>
      <PackSwitchRow ferretId="hadi-1" control={control} />
      <PackNote note={control.note} dismiss={control.dismiss} />
    </>
  );
}

const toggle = (root: HTMLElement) =>
  must(root.querySelector<HTMLInputElement>('[data-pack-ferret-switch] input'), 'the switch');

describe('Pack mode on one ferret', () => {
  it('reads a ferret as on, switches it off for the next launch, and says so', async () => {
    const daemon = fakeDaemon();
    mounted = await mount(<Page client={daemon.client} />);
    const root = mounted.container;
    expect(toggle(root).checked).toBe(true);
    await click(toggle(root));
    await waitForText(root, 'takes effect when the ferret restarts');
    expect(daemon.calls).toEqual([
      {
        key: 'PATCH /v1/ferrets/:ferretId/pack',
        init: { params: { ferretId: 'hadi-1' }, body: { enabled: false } },
      },
    ]);
    expect(must(root.querySelector('[data-pack-action-note]'), 'note').getAttribute('role')).toBe('status');
    // The daemon's answer is kept, so the switch does not flip back.
    await waitFor(() => !toggle(root).checked, 'the switch to read off');
    await click(must(root.querySelector('button[aria-label="Dismiss"]'), 'Dismiss'));
    expect(root.querySelector('[data-pack-action-note]')).toBeNull();
  });

  it('says why a refused switch did not change', async () => {
    const daemon = fakeDaemon();
    daemon.refusals.push({ status: 403, message: 'operator access is closed', code: 'forbidden' });
    mounted = await mount(<Page client={daemon.client} />);
    await click(toggle(mounted.container));
    await waitForText(mounted.container, 'operator access is closed');
    expect(toggle(mounted.container).checked).toBe(true);
  });

  it('says plainly when the machine gave no words', async () => {
    const daemon = fakeDaemon();
    daemon.refusals.push({ status: 502 });
    mounted = await mount(<Page client={daemon.client} />);
    await click(toggle(mounted.container));
    await waitForText(mounted.container, 'This machine refused the change (502).');
  });
});
