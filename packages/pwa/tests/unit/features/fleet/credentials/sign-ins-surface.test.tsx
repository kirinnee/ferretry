import { afterEach, describe, expect, it } from 'bun:test';
import { SignInsSurface } from '../../../../../src/features/fleet/credentials/sign-ins-surface.tsx';
import type { MachineTabProps } from '../../../../../src/features/fleet/shell/machines-surface.tsx';
import { interact, mount, must } from '../../../../support/dom.ts';
import { APPLIED, type Call, machine, READS, STUDIO, scripted, stagedFrom } from '../account-support.ts';

const HASH = '#machines/studio-mac/sign-ins';

afterEach(() => {
  window.location.hash = '';
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
};

interface Asked {
  readonly groups: (string | undefined)[];
  readonly panels: (string | null | undefined)[];
}

/** Opens the surface at `hash`, drawing a marker for every panel group or panel the tab asks for. */
const open = async (hash: string, withPanels = true) => {
  window.location.hash = hash;
  const calls: Call[] = [];
  const client = scripted(
    { ...READS(), 'POST /v1/fleet/proposals': stagedFrom, 'POST /v1/fleet/proposals/change-1/apply': APPLIED },
    calls,
  );
  const asked: Asked = { groups: [], panels: [] };
  const daemonPanels: NonNullable<MachineTabProps['daemonPanels']> = (panel, _onOpen, group) => {
    asked.groups.push(group);
    asked.panels.push(panel);
    return panel === undefined ? <ul data-panels-group={group} /> : <section data-panel-shown={panel} />;
  };
  const view = await mount(
    <SignInsSurface
      connection={STUDIO}
      machineName="studio-mac"
      machine={machine()}
      online
      checking={false}
      onRetry={() => undefined}
      createClient={async () => client}
      {...(withPanels ? { daemonPanels } : {})}
    />,
  );
  await settle();
  return { view, asked };
};

describe('SignInsSurface', () => {
  it('holds the AI logins first, then the site accounts, secrets and secure copy as one group', async () => {
    const { view, asked } = await open(HASH);
    const surface = must(view.container.querySelector('[data-sign-ins-surface]'), 'the surface');
    const logins = must(surface.querySelector('[data-credentials-tab]'), 'the logins');
    const group = must(surface.querySelector('[data-panels-group="site-sign-ins"]'), 'the sign-in panels');
    expect(logins.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
    expect(surface.querySelectorAll('[data-credential-row]').length).toBeGreaterThan(0);
    expect(new Set(asked.groups)).toEqual(new Set(['site-sign-ins']));
    await view.unmount();
  });

  it('gives a login’s page the whole tab, and the panels return on the list', async () => {
    const { view } = await open(`${HASH}/claude-personal`);
    expect(view.container.querySelector('[data-credential-page="claude-personal"]')).not.toBeNull();
    expect(view.container.querySelector('[data-panels-group]')).toBeNull();
    await interact(() => must(view.container.querySelector<HTMLElement>('[data-page-back]'), 'back').click());
    await settle();
    expect(view.container.querySelector('[data-credential-row]')).not.toBeNull();
    expect(view.container.querySelector('[data-panels-group="site-sign-ins"]')).not.toBeNull();
    await view.unmount();
  });

  it('shows a panel the address names as a page of its own', async () => {
    for (const panel of ['accounts', 'secrets', 'secure-copy']) {
      const { view } = await open(`${HASH}/${panel}`);
      expect(view.container.querySelector(`[data-panel-shown="${panel}"]`)).not.toBeNull();
      expect(view.container.querySelector('[data-sign-ins-surface]')).toBeNull();
      await view.unmount();
    }
  });

  it('shows the logins for a panel word that belongs to another tab', async () => {
    const { view, asked } = await open(`${HASH}/warden`);
    expect(view.container.querySelector('[data-panel-shown]')).toBeNull();
    expect(view.container.querySelector('[data-sign-ins-surface]')).not.toBeNull();
    expect(asked.panels.every(panel => panel === undefined)).toBe(true);
    await view.unmount();
  });

  it('holds just the logins when the shell supplies no panels', async () => {
    const { view } = await open(HASH, false);
    expect(view.container.querySelector('[data-credentials-tab]')).not.toBeNull();
    expect(view.container.querySelector('[data-panels-group]')).toBeNull();
    await view.unmount();
  });
});
