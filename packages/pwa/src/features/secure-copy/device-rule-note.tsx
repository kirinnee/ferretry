/**
 * Under a paired device's Revoke: how many standing sign-in rules its passkey approved, because revoking the device
 * suspends them. Says nothing when there are none, and nothing on a device that may not read the rules.
 */

import { deviceRevokeWarning, type RuleClient, rulesApprovedWith } from '../../lib/sign-in-rules.ts';
import { useSignInRules } from '../accounts/use-sign-in-rules.ts';

export function DeviceRuleNote({ client, deviceId }: { readonly client: RuleClient; readonly deviceId: string }) {
  const { read } = useSignInRules(client);
  if (read.kind !== 'ready') return null;
  const count = rulesApprovedWith(read.list.rules, deviceId);
  if (count === 0) return null;
  return (
    <p className="m-0 text-meta leading-base text-warn" data-device-rules={deviceId}>
      {deviceRevokeWarning(count)}
    </p>
  );
}
