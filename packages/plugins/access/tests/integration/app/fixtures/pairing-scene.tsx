/**
 * The browser entry for the pair page with its mascot and night sky, over fake data: the REAL `PairingScreen`.
 * No daemon, no real code: the seed is a fixed fake, and the daemon is on the relay path (its link carries a loopback
 * address that means nothing on this device), so the screen says "through the relay" and shows no `127.0.0.1`.
 *
 *   ?theme=<family>-<mode>
 *   &arrival=link|cold|broken   a pairing link (default), a cold open, or a link whose redemption fails
 *   &offer=open                the machine says the first-passkey window is open (7 minutes left): the success screen offers
 *                              "Add a passkey now" and waits for "Not now"
 *   &unlock=1                  the machine unlocks on opening: its unlock gate (the REAL `StepUpGate` and unlock `StepUpDialog`) gets a request refused for
 *                              want of an unlock right after pairing, as the real one does (S-11); a press on its prompt counts in `window.__pairScene.unlocked`
 *   &daemon=<url>              the address the link carries (default a loopback one): a named host prefills "Name this machine", an IP does not
 *   &same=1                    the page runs on the daemon's own machine (`sameMachine`): the line is the direct one, with its address
 *   &scan=camera              a browser that can scan (an idle camera), so the cold page shows all three ways in
 *   &back=1                    the host gave the page a way back (Back), as `/pair` does when reached from Settings or the first run
 *   &motion=reduced             the app's own Motion = Reduced (`<html data-motion="reduced">`)
 *   &scene=export              ONLY the cheering ferret, imported from the Access app's export (`FerretMascot`, which the
 *                              onboarding End page uses): proves the export draws the same reacting mascot
 *   &scene=end-panel           ONLY the `end-mascot` panel Access places in Onboarding's `onboarding.end` slot (r11-1b G1)
 */

import { createRoot } from 'react-dom/client';
import { FerretMascot } from '../../../../app/index.ts';
import { EndMascotPanel } from '../../../../app/features/onboarding/end-mascot-panel.tsx';
import { StepUpDialog, UNLOCK_COPY } from '../../../../app/features/step-up/step-up-dialog.tsx';
import {
  inlinePasskeyOffered,
  onInlinePasskeyOffer,
  provideInlineUnlock,
} from '../../../../app/lib/inline-passkey-offer.ts';
import { StepUpGate } from '../../../../app/lib/step-up-gate.ts';
import { PairingScreen } from '../../../../app/features/pairing/pairing-screen.tsx';
import type { StepUpClient } from '../../../../app/lib/step-up-client.ts';
import { daemonConnection } from '../../../../app/shell-pairing.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
if (params.get('motion') === 'reduced') document.documentElement.dataset.motion = 'reduced';

const SEED = {
  daemonUrl: params.get('daemon') ?? 'http://127.0.0.1:7617',
  daemonId: 'fy_daemon_9k3q2m7x4n8v1b6c5z0wd2f8',
  code: 'FAKE-0000',
};
const arrival = params.get('arrival') ?? 'link';

// A stand-in daemon that keeps the name typed while pairing, as the real one does (the REAL Access half and host are
// proved in `tests/integration/daemon/pairing/pair-machine-name.test.ts`; here the screen is what is under test). What it
// was sent and the passkey it was asked to create are left on `window.__pairScene` for the browser test to read.
const HOST_NAME = 'kirin-workstation';
const pairScene = { sent: [] as { deviceName: string; machineName?: string }[], created: [] as unknown[] };
(window as unknown as { __pairScene: typeof pairScene }).__pairScene = pairScene;
let daemonName = HOST_NAME;
let pairedAs = '';
const b64 = (value: number) => btoa(String.fromCharCode(value)).replace(/=+$/u, '');

// A machine whose first-passkey window closes in seven minutes (fake clock, fake view). Its passkey labels read the
// name it now goes by: "<device> → <machine>", then "Ferretry: <device> → <machine>" (the daemon's own composition).
const OFFER_NOW = Date.parse('2026-11-17T10:00:00.000Z');
let passkeyReads = 0;
const openWindow: StepUpClient = {
  request: async <T,>(path: string, schema: { parse: (value: unknown) => T }): Promise<T> => {
    if (path === '/v1/passkeys/options')
      return schema.parse({
        challenge: b64(9),
        rp: { id: 'ferretry.example', name: 'Ferretry' },
        user: { id: b64(1), name: `${pairedAs} → ${daemonName}`, displayName: `Ferretry: ${pairedAs} → ${daemonName}` },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        timeout: 60_000,
        excludeCredentials: [],
      });
    passkeyReads += 1;
    return schema.parse(
      passkeyReads > 1
        ? { id: b64(0xaa), createdAt: '2026-11-17T10:03:00.000Z', origin: 'https://ferretry.example' }
        : { passkeys: [], registration: 'first-window', registrationClosesAt: '2026-11-17T10:07:00.000Z' },
    );
  },
};
const fakeCredentials = {
  create: async (options: unknown) => {
    pairScene.created.push(JSON.parse(JSON.stringify((options as { publicKey: unknown }).publicKey)));
    return {
      type: 'public-key',
      rawId: Uint8Array.from([0xaa]).buffer,
      response: {
        clientDataJSON: Uint8Array.from([0x7b, 0x7d]).buffer,
        attestationObject: Uint8Array.from([1]).buffer,
        getTransports: () => [],
      },
    } as unknown as Credential;
  },
  get: async () => null,
};
const offering = params.get('offer') === 'open';

// THE UNLOCK GATE (S-11): the machine just paired with answers the app's first read `401 unlock_required`, so the gate has a
// background request waiting for it. Held while a card is offering or finishing the first passkey; the unlock itself takes a moment.
const unlockScene = params.get('unlock') === '1';
const unlocks = { count: 0 };
(window as unknown as { __pairScene: Record<string, unknown> }).__pairScene.unlocked = unlocks;
const unlockGate = new StepUpGate({
  ceremony: async () => {
    await new Promise(resolve => setTimeout(resolve, 150));
    unlocks.count += 1;
  },
  describe: () => 'The passkey confirmation did not finish. Try again.',
  held: inlinePasskeyOffered,
});
if (unlockScene) {
  onInlinePasskeyOffer(() => unlockGate.recheck());
  provideInlineUnlock({ needed: async () => true, run: async daemon => await unlockGate.confirmInline(daemon) });
}

const root = document.getElementById('root');
if (root === null) throw new Error('the scene page has no #root');
if (params.get('scene') === 'export') {
  createRoot(root).render(
    <div data-export-mascot="" style={{ width: 240, margin: '80px auto' }}>
      <FerretMascot pose="cheer" />
    </div>,
  );
} else if (params.get('scene') === 'end-panel') {
  createRoot(root).render(
    <div data-export-mascot="" style={{ width: 340, margin: '80px auto' }}>
      <EndMascotPanel />
    </div>,
  );
} else
  createRoot(root).render(
    <>
      {unlockScene ? <StepUpDialog gate={unlockGate} copy={UNLOCK_COPY} machineName={() => 'QA Box'} /> : null}
      <PairingScreen
        connections={[]}
        selectedDaemonId={null}
        arrival={arrival === 'cold' ? { kind: 'none' } : { kind: 'seed', seed: SEED }}
        sameMachine={params.get('same') === '1'}
        {...(params.get('scan') === 'camera'
          ? { scanHost: { supported: true, scan: async () => await new Promise<string>(() => {}) } }
          : {})}
        defaultName={() => 'Chrome on Linux · 4f2a'}
        onPair={async (_seed, deviceName, machineName) => {
          pairScene.sent.push({ deviceName, ...(machineName === undefined ? {} : { machineName }) });
          await new Promise(resolve => setTimeout(resolve, 300));
          if (arrival === 'broken') throw new Error('Nothing reached that daemon.');
          pairedAs = deviceName;
          if (unlockScene)
            setTimeout(
              () =>
                void unlockGate.require(
                  daemonConnection({ daemonId: SEED.daemonId, baseUrl: SEED.daemonUrl, deviceId: 'fy_device_id_fake' }),
                  undefined,
                  'background',
                ),
              0,
            );
          if (unlockScene) unlockGate.focus(SEED.daemonId as never);
          daemonName = machineName ?? HOST_NAME;
          return {
            machine: daemonName,
            via: 'relay' as const,
            connection: daemonConnection({
              daemonId: SEED.daemonId,
              baseUrl: SEED.daemonUrl,
              deviceId: 'fy_device_id_fake',
            }),
          };
        }}
        {...(offering
          ? {
              passkeyClient: async () => openWindow,
              passkeyOffer: {
                now: () => OFFER_NOW,
                supported: () => true,
                origin: () => 'https://ferretry.example',
                credentials: () => fakeCredentials,
              },
              onContinue: () => {},
            }
          : {})}
        {...(params.get('back') === '1'
          ? { onClose: () => document.documentElement.setAttribute('data-went-back', '') }
          : {})}
        onRemove={() => {}}
        onSelect={() => {}}
      />
    </>,
  );
