/**
 * Under a paired device's Revoke (Access's `access.device-note` slot): how many standing sign-in rules its passkey
 * approved, because revoking the device suspends them. Says nothing when there are none, while the rules are read, and on
 * a device that may not read them: a note that cannot be proved is not drawn. It holds only the device's public id (the
 * slot's `subject`) and a count; no rule, account or username is drawn.
 */

import { useSignInRules } from '../accounts/use-sign-in-rules.ts';
import { deviceRevokeWarning, type RuleClient, rulesApprovedWith } from '../../lib/sign-in-rules.ts';

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
