/**
 * THE SLOT ACCESS OFFERS UNDER EACH PAIRED DEVICE'S REVOKE (§5.2: plugin screens offer their own, `<plugin>.<name>`).
 *
 * Access mounts whatever panels an installed plugin contributes here, each handed the device's id as its `subject`. A
 * panel says one line about what revoking THAT device does that Access does not know: Accounts says how many standing
 * sign-in rules the device's passkey approved, because revoking it suspends them. Access knows nothing of rules and
 * imports nothing of Accounts: the name and the subject are the whole agreement (Accounts writes the same name in its
 * own contract/slots.ts, and the shell's slot test pairs the two). A panel with nothing to say draws nothing, and where no
 * panel is placed the row shows no note; revoking itself is unchanged. Only the device's public id, which the row
 * already shows, crosses: no key, no token and no digest (docs/pairing.md).
 */
export const DEVICE_NOTE_SLOT = 'access.device-note' as const;
