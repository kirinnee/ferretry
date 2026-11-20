/**
 * The browser entry for the `access.passkey` client step over fake data: the REAL `PasskeyStep` inside the REAL
 * `StepPageFrame`, with a fake machine (first-passkey window open, 7 minutes left) and a fake `StepHost`. No daemon,
 * no real credential: the ceremony is a fake that resolves, so nothing here ever asks a browser for a passkey.
 *
 *   ?theme=<family>-<mode>
 */
import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { StepPageFrame, type CredentialsPort } from '@ferretry/app';
import type { StepHost } from '@ferretry/kernel/contract';
import { PasskeyStep } from '../../../../app/features/onboarding/passkey-step.tsx';
import type { StepUpClient } from '../../../../app/lib/step-up-client.ts';
import { daemonConnection } from '../../../../app/shell-pairing.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const NOW = Date.parse('2026-11-17T10:00:00.000Z');
const connection = daemonConnection({
  daemonId: 'fy_daemon_fake',
  baseUrl: 'http://127.0.0.1:7617',
  deviceId: 'fy_device_fake',
});
const bytes = (...values: number[]) => Uint8Array.from(values).buffer as ArrayBuffer;
const b64 = (value: number) => btoa(String.fromCharCode(value)).replace(/=+$/u, '');

let reads = 0;
const machine: StepUpClient = {
  request: async <T,>(path: string, schema: { parse: (value: unknown) => T }): Promise<T> => {
    if (path === '/v1/passkeys/options')
      return schema.parse({
        challenge: b64(9),
        rp: { id: 'ferretry.example', name: 'Ferretry' },
        user: { id: b64(1), name: 'device', displayName: 'device' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        timeout: 60_000,
        excludeCredentials: [],
      });
    reads += 1;
    return schema.parse(
      reads > 1
        ? { id: b64(0xaa), createdAt: '2026-11-17T10:03:00.000Z', origin: 'https://ferretry.example' }
        : { passkeys: [], registration: 'first-window', registrationClosesAt: '2026-11-17T10:07:00.000Z' },
    );
  },
};
/** What the page did, for the browser test to read: ceremonies started and times the step moved on. */
const scene = { creates: 0, nexts: 0 };
(window as unknown as { __passkeyScene: typeof scene }).__passkeyScene = scene;
const fakeCredentials: CredentialsPort = {
  create: async () => {
    scene.creates += 1;
    return {
      type: 'public-key',
      rawId: bytes(0xaa),
      response: { clientDataJSON: bytes(0x7b, 0x7d), attestationObject: bytes(1), getTransports: () => [] },
    } as unknown as Credential;
  },
  get: async () => null,
};

function Scene() {
  const [busy, setBusy] = useState(false);
  const host = useMemo<StepHost>(
    () => ({
      phase: 'client',
      appliesTo: [],
      segment: {},
      remember: () => {},
      ready: () => {},
      skip: () => {},
      notNeeded: () => {},
      commit: () => undefined,
      done: () => {},
      busy: label => setBusy(label !== null),
      next: () => {
        scene.nexts += 1;
      },
      back: () => {},
    }),
    [],
  );
  return (
    <StepPageFrame
      title="Add a passkey to this device"
      line="A passkey confirms changes on this machine. It stays on this device."
      back={{}}
      next={{ label: 'Next', busy }}
      progress={{
        segments: [
          { id: 'machine', label: 'Machine' },
          { id: 'device', label: 'This device' },
        ],
        current: 'device',
        step: 3,
        of: 4,
      }}
    >
      <PasskeyStep
        step={host}
        connection={connection}
        createClient={async () => machine}
        credentials={() => fakeCredentials}
        origin={() => 'https://ferretry.example'}
        supported={() => true}
        now={() => NOW}
      />
    </StepPageFrame>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('the scene page has no #root');
createRoot(root).render(<Scene />);
