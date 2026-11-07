import { afterEach, describe, expect, it } from 'bun:test';
import { ModelSetsTab } from '../../../../../app/features/fleet/components/model-sets-tab.tsx';
import { ProfilesTab } from '../../../../../app/features/fleet/profiles/profiles-tab.tsx';
import { RuntimesTab } from '../../../../../app/features/fleet/runtimes/runtimes-tab.tsx';
import type { MachineTabProps } from '../../../../../app/features/fleet/shell/machine-tab.ts';
import { interact, type Mounted, mount as mountView, must } from '../../../support/dom.ts';
import { scripted } from '../../support/client.ts';
import { machine, READS } from './account-support.ts';

const mounted: Mounted[] = [];

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 8; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const props = (routes: Record<string, unknown> = READS()): MachineTabProps => ({
  client: scripted(routes),
  machineName: 'studio-mac',
  machine: machine(),
  online: true,
  checking: false,
  onRetry: () => undefined,
});

const open = async (element: Parameters<typeof mountView>[0]): Promise<Mounted> => {
  const view = await mountView(element);
  mounted.push(view);
  await settle();
  return view;
};

afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
  window.location.hash = '';
});

describe('the Runtimes tab', () => {
  it('lists every runtime on the machine, each with its launch link', async () => {
    const view = await open(<RuntimesTab {...props()} />);
    const rows = [...view.container.querySelectorAll('[data-runtime-row]')].map(row =>
      row.getAttribute('data-runtime-row'),
    );
    expect(rows).toContain('claude-default');
    expect(rows).toContain('codex-default');
  });

  it('says so when the machine cannot be read', async () => {
    const view = await open(<RuntimesTab {...props({})} />);
    expect(view.container.querySelector('[data-runtime-row]')).toBeNull();
    expect(view.container.textContent?.length).toBeGreaterThan(0);
  });
});

describe('the Profiles tab', () => {
  it('lists the profiles the daemon returned', async () => {
    const view = await open(<ProfilesTab {...props()} />);
    expect(view.container.textContent).toContain('Default');
    expect(view.container.textContent).toContain('Claude hooks');
  });
});

describe('the Model sets tab', () => {
  it('lists the model sets and opens one to its models', async () => {
    const view = await open(<ModelSetsTab {...props()} />);
    const row = must(
      view.container.querySelector<HTMLElement>('[data-component-row="modelSets/Claude models"]'),
      'row',
    );
    expect(view.container.textContent).not.toContain('Main instructions');
    await interact(() => row.querySelector('button')?.click() ?? row.click());
    await settle();
    expect(view.container.querySelector('[data-components-page="detail"]')).not.toBeNull();
    expect(view.container.textContent).toContain('Opus 5.5');
    expect(view.container.textContent).toContain('Sonnet 5.5');
  });
});
