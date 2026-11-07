import { describe, expect, it } from 'bun:test';
import { ChangeApplyPanel } from '../../../src/ui/change-apply-panel.tsx';
import {
  changeAuthorityOf,
  type ChangeAuthority,
  GRANTS_ROUTE,
  readChangeAuthority,
  useChangeAuthority,
} from '../../../src/ui/change-authority.ts';
import { interact, mount, must } from '../../support/dom.ts';

const click = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  await interact(() => target.click());
};

const grants = (fleet: { configure: boolean; configureRefusal: string } | undefined) => ({
  capabilities: [
    { capability: 'terminal', use: true, configure: true, configureRefusal: 'granted' },
    ...(fleet === undefined ? [] : [{ capability: 'fleet', use: true, ...fleet }]),
  ],
  governed: true,
  hostLocal: false,
  steppedUp: false,
});

describe('ChangeApplyPanel', () => {
  it('submits at once when nothing is owed, and waits while authority is being read', async () => {
    let sent = 0;
    const reading = await mount(
      <ChangeApplyPanel
        machineName="studio-mac"
        authority={null}
        busy={false}
        refusal={null}
        submitLabel="Create runtime"
        onSubmit={() => {
          sent += 1;
        }}
      />,
    );
    expect(reading.container.querySelector('[data-change-apply]')?.getAttribute('data-change-apply')).toBe('reading');
    expect((reading.container.querySelector('[data-change-submit]') as HTMLButtonElement).disabled).toBe(true);
    await reading.unmount();

    const view = await mount(
      <ChangeApplyPanel
        machineName="studio-mac"
        authority={{ kind: 'open' }}
        busy={false}
        refusal="The setup changed since this was staged."
        submitLabel="Create runtime"
        onSubmit={() => {
          sent += 1;
        }}
      />,
    );
    expect(view.container.querySelector('[data-change-step-up]')).toBeNull();
    expect(view.container.querySelector('[data-change-refusal]')?.textContent).toBe(
      'The setup changed since this was staged.',
    );
    await click(view.container.querySelector('[data-change-submit]'), 'submit');
    expect(sent).toBe(1);
    await view.unmount();
  });

  it('says the passkey will be asked for, in plain words, and still submits', async () => {
    let sent = 0;
    const view = await mount(
      <ChangeApplyPanel
        machineName="studio-mac"
        authority={{ kind: 'step-up' }}
        busy={false}
        refusal={null}
        submitLabel="Sign out"
        variant="danger"
        onSubmit={() => {
          sent += 1;
        }}
      />,
    );
    const note = view.container.querySelector('[data-change-step-up]')?.textContent ?? '';
    expect(note).toBe('studio-mac will ask you to confirm with your passkey when you save.');
    expect(note.toLowerCase()).not.toContain('password');
    const submit = must(view.container.querySelector<HTMLButtonElement>('[data-change-submit]'), 'submit');
    expect(submit.disabled).toBe(false);
    await click(submit, 'submit');
    expect(sent).toBe(1);
    await view.unmount();

    const busy = await mount(
      <ChangeApplyPanel
        machineName="studio-mac"
        authority={{ kind: 'step-up' }}
        busy
        busyLabel="Signing out…"
        refusal={null}
        submitLabel="Sign out"
        onSubmit={() => undefined}
      />,
    );
    expect(busy.container.querySelector('[data-change-submit]')?.textContent).toBe('Signing out…');
    expect((busy.container.querySelector('[data-change-submit]') as HTMLButtonElement).disabled).toBe(true);
    await busy.unmount();
  });

  it('a grant refusal says why, in the shared words, and offers no button that works', async () => {
    let sent = 0;
    const view = await mount(
      <ChangeApplyPanel
        machineName="studio-mac"
        authority={{ kind: 'refused', refusal: 'not-granted' }}
        busy={false}
        refusal={null}
        submitLabel="Create runtime"
        onSubmit={() => {
          sent += 1;
        }}
      />,
    );
    expect(view.container.querySelector('[data-change-grant-refused]')?.textContent).toContain(
      'switched off the agent fleet for paired devices',
    );
    expect((view.container.querySelector('[data-change-submit]') as HTMLButtonElement).disabled).toBe(true);
    await view.unmount();
    expect(sent).toBe(0);
  });
});

describe('changeAuthorityOf', () => {
  it('reads the fleet row: open when it may configure, step-up for a passkey, refused with the reason otherwise', () => {
    expect(changeAuthorityOf(grants({ configure: true, configureRefusal: 'granted' }))).toEqual({ kind: 'open' });
    expect(changeAuthorityOf(grants({ configure: false, configureRefusal: 'step-up-required' }))).toEqual({
      kind: 'step-up',
    });
    expect(changeAuthorityOf(grants({ configure: false, configureRefusal: 'device-not-granted' }))).toEqual({
      kind: 'refused',
      refusal: 'device-not-granted',
    });
  });

  it('is never an open button when it cannot tell: no fleet row is undetermined, an unreadable answer is unreadable', () => {
    expect(changeAuthorityOf(grants(undefined))).toEqual({ kind: 'refused', refusal: 'undetermined' });
    expect(changeAuthorityOf({ nonsense: true })).toEqual({ kind: 'unreadable' });
    expect(changeAuthorityOf(undefined)).toEqual({ kind: 'unreadable' });
  });
});

describe('readChangeAuthority', () => {
  it('asks Gate for the grants through the half’s own client', async () => {
    const asked: string[] = [];
    const client = {
      call: async (route: string) => {
        asked.push(route);
        return grants({ configure: true, configureRefusal: 'granted' });
      },
    };

    expect(await readChangeAuthority(client as never)).toEqual({ kind: 'open' });
    expect(asked).toEqual([GRANTS_ROUTE]);
  });

  it('says unreadable, not refused, when the machine did not answer', async () => {
    const client = {
      call: async () => {
        throw new Error('down');
      },
    };

    expect(await readChangeAuthority(client as never)).toEqual({ kind: 'unreadable' });
  });
});

describe('useChangeAuthority', () => {
  it('reads once per client and starts over for another machine', async () => {
    const make = (configure: boolean, refusal: string) => ({
      call: async () => grants({ configure, configureRefusal: refusal }),
    });
    const seen: (ChangeAuthority | null)[] = [];
    function Host({ client }: { readonly client: ReturnType<typeof make> }) {
      const authority = useChangeAuthority(client as never);
      seen.push(authority);
      return <p data-authority={authority?.kind ?? 'reading'} />;
    }

    const view = await mount(<Host client={make(true, 'granted')} />);
    await interact(async () => {
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    });

    expect(view.container.querySelector('[data-authority]')?.getAttribute('data-authority')).toBe('open');
    expect(seen[0]).toBeNull();
    await view.unmount();
  });
});
