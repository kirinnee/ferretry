/**
 * The `onboarding-passkey` panel: `access.passkey`'s page for the machine in scope, built per machine against that
 * machine's own Access client (the same reach Settings › Security uses). It draws only for its own step's subject.
 */
import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { pairingClientOf, useMachineOf } from '../../daemon-scope.tsx';
import { PasskeyStep } from './passkey-step.tsx';

export function passkeyStepPanel(client: PluginClient) {
  // One factory per built half, so the page's read does not restart on every render.
  const createClient = async () => pairingClientOf(client);
  return function PasskeyStepPanel({ step }: PanelProps) {
    const connection = useMachineOf();
    return <PasskeyStep step={step} connection={connection} createClient={createClient} />;
  };
}
