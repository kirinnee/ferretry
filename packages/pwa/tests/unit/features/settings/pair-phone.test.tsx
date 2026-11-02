import { afterEach, describe, expect, it } from 'bun:test';
import {
  type CapabilityGrantView,
  DAEMON_CAPABILITIES,
  type GrantRefusal,
  type GrantsView,
  type PairedDevicesView,
} from '@ferretry/protocol';
import { useState } from 'react';
import type { PairingClientFactory } from '../../../../src/features/settings/add-device-settings.tsx';
import {
  mayPairPhone,
  PAIR_PHONE_DESCRIPTION,
  type PairingGrantsClientFactory,
  type PairPhonePresentation,
  PairPhoneSheet,
  pairPhoneLabel,
  usePairPhoneAllowed,
} from '../../../../src/features/settings/pair-phone.tsx';
import { type DaemonConnection, daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { DaemonClientProvider } from '../../../../src/lib/store.tsx';
import { interact, type Mounted, mount, must, pressKey } from '../../../support/dom.ts';

const ALPHA = `fy_daemon_${'a'.repeat(43)}`;
const BETA = `fy_daemon_${'b'.repeat(43)}`;
const connection = (id: string): DaemonConnection =>
  daemonConnection({ daemonId: id, baseUrl: 'https://workstation.example.test', deviceId: `token-${id}` });

const entry = (capability: CapabilityGrantView['capability'], useRefusal: GrantRefusal): CapabilityGrantView => ({
  capability,
  use: useRefusal === 'granted',
  configure: false,
  granted: { use: useRefusal !== 'not-granted', configure: false },
  mayGrant: false,
  useRefusal,
  configureRefusal: 'not-granted',
  origin: 'default',
});

const grants = (pairing: GrantRefusal | null): GrantsView => ({
  capabilities: DAEMON_CAPABILITIES.filter(capability => pairing !== null || capability !== 'pairing').map(capability =>
    entry(capability, capability === 'pairing' && pairing !== null ? pairing : 'granted'),
  ),
  governed: true,
  hostLocal: false,
  steppedUp: false,
});

/** The FAKE code every committed capture uses; nothing here mints a real one. */
const DEVICES: PairedDevicesView = { devices: [], hostLocal: false, mayWiden: undefined as never };

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 6; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

describe('who is offered "Pair a phone"', () => {
  it('offers it when pairing is open, or waits only on a passkey, and never otherwise', () => {
    expect(mayPairPhone(grants('granted'))).toBe(true);
    expect(mayPairPhone(grants('step-up-required'))).toBe(true);
    expect(mayPairPhone(grants('not-granted'))).toBe(false);
    expect(mayPairPhone(grants('device-not-granted'))).toBe(false);
    expect(mayPairPhone(grants('undetermined'))).toBe(false);
    // A view that does not mention pairing at all is not a yes.
    expect(mayPairPhone(grants(null))).toBe(false);
  });

  it('words the act apart from "Add a machine"', () => {
    expect(pairPhoneLabel('studio')).toBe('Pair a phone with studio');
    expect(PAIR_PHONE_DESCRIPTION).toContain('Settings › Devices');
  });
});

function AllowedProbe({
  target,
  createClient,
}: {
  readonly target: DaemonConnection | undefined;
  readonly createClient?: PairingGrantsClientFactory;
}) {
  const allowed = usePairPhoneAllowed(target, createClient);
  return <p data-allowed={String(allowed)}>{String(allowed)}</p>;
}

const allowedText = (): string | null | undefined => view?.container.querySelector('[data-allowed]')?.textContent;

describe('usePairPhoneAllowed', () => {
  it('reads this machine’s grants, and keys the answer by machine', async () => {
    const asked: string[] = [];
    const answers: Record<string, GrantsView> = { [ALPHA]: grants('granted'), [BETA]: grants('not-granted') };
    const factory: PairingGrantsClientFactory = async target => {
      asked.push(`${target.daemonId}`);
      return {
        request: (async (path: string) => {
          expect(path).toBe('/v1/grants');
          return answers[`${target.daemonId}`];
        }) as never,
      };
    };
    const alpha = connection(ALPHA);
    view = await mount(<AllowedProbe createClient={factory} target={alpha} />);
    await settle();
    expect(allowedText()).toBe('true');

    // The same machine through a re-created connection object is not asked again.
    await view.render(<AllowedProbe createClient={factory} target={connection(ALPHA)} />);
    await settle();
    expect(asked).toEqual([ALPHA]);

    // Another machine is asked for itself, and its no is not overridden by the first machine's yes.
    await view.render(<AllowedProbe createClient={factory} target={connection(BETA)} />);
    await settle();
    expect(allowedText()).toBe('false');
    expect(asked).toEqual([ALPHA, BETA]);
  });

  it('reads false with no machine, and when the machine cannot be asked', async () => {
    view = await mount(<AllowedProbe target={undefined} />);
    await settle();
    expect(allowedText()).toBe('false');
    await view.unmount();

    view = await mount(
      <AllowedProbe
        createClient={async () => {
          throw new Error('offline');
        }}
        target={connection(ALPHA)}
      />,
    );
    await settle();
    expect(allowedText()).toBe('false');
  });

  it('drops a late answer for a machine that is no longer on screen', async () => {
    let release: (view: GrantsView) => void = () => undefined;
    const factory: PairingGrantsClientFactory = async () => ({
      request: (async () => await new Promise<GrantsView>(resolve => (release = resolve))) as never,
    });
    view = await mount(<AllowedProbe createClient={factory} target={connection(ALPHA)} />);
    await settle();
    await view.render(<AllowedProbe createClient={factory} target={undefined} />);
    await interact(() => release(grants('granted')));
    await settle();
    expect(allowedText()).toBe('false');
  });

  it('uses the routed daemon client when none is handed in', async () => {
    const routed = async () =>
      ({ request: async () => grants('step-up-required') }) as unknown as Awaited<
        ReturnType<PairingGrantsClientFactory>
      >;
    view = await mount(
      <DaemonClientProvider client={routed as never}>
        <AllowedProbe target={connection(ALPHA)} />
      </DaemonClientProvider>,
    );
    await settle();
    expect(allowedText()).toBe('true');
  });
});

const pairingClient: PairingClientFactory = async () => ({
  request: (async (path: string) => {
    if (path === '/v1/pair/devices') return DEVICES;
    throw new Error(`unexpected ${path}`);
  }) as never,
});

function SheetHost({
  presentation,
  initiallyOpen = true,
}: {
  readonly presentation: PairPhonePresentation;
  readonly initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <button data-opener="" onClick={() => setOpen(true)} type="button">
        open
      </button>
      <PairPhoneSheet
        connection={connection(ALPHA)}
        createClient={pairingClient}
        machineName="studio"
        now={() => Date.parse('2026-01-01T00:00:00.000Z')}
        onClose={() => setOpen(false)}
        open={open}
        presentation={presentation}
      />
    </>
  );
}

describe('PairPhoneSheet', () => {
  it('opens the Add-a-device surface in a dialog, and closes on Escape back to its opener', async () => {
    view = await mount(<SheetHost initiallyOpen={false} presentation="dialog" />);
    expect(document.querySelector('[data-pair-phone]')).toBeNull();
    const opener = must(document.querySelector<HTMLButtonElement>('[data-opener]'), 'the opener');
    await interact(() => {
      opener.focus();
      opener.click();
    });
    await settle();
    const dialog = must(
      document.querySelector<HTMLElement>('[data-pair-phone="dialog"] [role="dialog"]'),
      'the dialog',
    );
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const title = must(document.getElementById(must(dialog.getAttribute('aria-labelledby'), 'a label')), 'the title');
    expect(title.textContent).toBe('Pair a phone with studio');
    expect(document.activeElement).toBe(dialog);
    // The surface itself, unchanged: the same panel Settings › Devices shows.
    expect(dialog.querySelector('[data-pair-phone-body]')?.textContent).toContain('No paired device can reach');
    await interact(() => pressKey(dialog, 'Escape'));
    expect(document.querySelector('[data-pair-phone]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes from its own Close button and from the scrim', async () => {
    view = await mount(<SheetHost presentation="dialog" />);
    await settle();
    await interact(() => must(document.querySelector<HTMLButtonElement>('[data-pair-phone-close]'), 'Close').click());
    expect(document.querySelector('[data-pair-phone]')).toBeNull();
    await interact(() => must(document.querySelector<HTMLButtonElement>('[data-opener]'), 'opener').click());
    await interact(() =>
      must(
        document.querySelector<HTMLButtonElement>('[data-pair-phone="dialog"] > button[aria-label="Close pairing"]'),
        'the scrim',
      ).click(),
    );
    expect(document.querySelector('[data-pair-phone]')).toBeNull();
  });

  it('is a bottom sheet on a phone, and mounts the surface only while it is open', async () => {
    view = await mount(<SheetHost presentation="sheet" />);
    await settle();
    const sheet = must(document.querySelector<HTMLElement>('[data-bottom-sheet="pair-phone"]'), 'the sheet');
    expect(sheet.querySelector('[data-pair-phone="sheet"] h2')?.textContent).toBe('Pair a phone with studio');
    expect(sheet.querySelector('[data-pair-phone-body]')).not.toBeNull();
    await interact(() => pressKey(must(sheet.querySelector<HTMLElement>('[role="dialog"]'), 'the panel'), 'Escape'));
    // The surface — and with it any code on screen — is gone the moment the sheet is dismissed.
    expect(document.querySelector('[data-pair-phone-body]')).toBeNull();
  });
});
