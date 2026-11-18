/**
 * What an ask card draws in place of its data while the daemon wants the owner's step-up for the read and the owner has
 * not acted yet. Pressing it is the owner's act, so the passkey is asked for then and only then. The one shared button
 * (`@ferretry/app/ui`), also what the owner-only pages draw after a cancelled prompt.
 */

export { ConfirmToSee } from '@ferretry/app/ui';
