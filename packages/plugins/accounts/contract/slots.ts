/**
 * THE SLOT ACCOUNTS FILLS ON ACCESS'S ADD DEVICE PAGE.
 *
 * Under each paired device's Revoke, Access mounts the panels an installed plugin contributes and hands each the device's
 * id as its `subject`. Accounts' panel says how many standing sign-in rules that device's passkey approved, because
 * revoking the device suspends them. Access owns the name and what it carries (its app half's `device-note-slot.ts`);
 * the name is written here because Access's contract does not name it and Accounts must not edit another plugin's
 * contract. The shell's slot test pairs the two, so renaming either side fails there instead of drawing no note.
 * Nothing but the device's public id crosses: no key, no token, no rule.
 */

/** Under a paired device's Revoke on Add device: what else revoking it does. `subject` is the device's id. */
export const ACCESS_DEVICE_NOTE_SLOT = 'access.device-note' as const;

/** Every slot of another plugin's page that Accounts contributes a panel to. */
export const ACCOUNTS_CONTRIBUTED_SLOTS = [ACCESS_DEVICE_NOTE_SLOT] as const;
