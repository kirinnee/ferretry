/**
 * THE SLOT THE INPUT CARD OFFERS WHILE IT ASKS FOR A CODE (§5.2: plugin screens offer their own, named `<plugin>.<name>`).
 *
 * A card that asks for a one-time code is where the owner sees that Ferretry could make the code itself. Setting that
 * up (typing a 2FA seed, binding it to a passkey, "use it now") is ACCOUNTS' to do, and the Vault must not know how it
 * is drawn or what it stores. So the card OFFERS this slot under its saved accounts and mounts whatever panels any
 * installed plugin contributes to it (Accounts contributes "Set up automatic codes"); neither half imports the other. A
 * daemon without Accounts shows the card with no extra line, and Accounts without this card shows nothing extra.
 *
 * The props are plain data and one callback: the ids and place keys the card already holds (`request.saved`, which the
 * daemon sends only to an owner who may use secrets), never a typed value, never a code, never a seed. The slot is
 * mounted ONLY while the card is pending and asks a code; a filler that needs a value gets it from its own field.
 */
import { type InputSaved, InputSavedSchema } from './inputs-wire.ts';

export const INPUT_CARD_CODES_SLOT = 'vault.input-card-codes' as const;

/** What the card hands a panel in {@link INPUT_CARD_CODES_SLOT}, beside the shell's `subject` (the ferret). */
export interface InputCardCodesSlotProps {
  /** The request the card is for: what a staged seed names to be "used now" on this very card. */
  readonly requestId: string;
  /** The ferret that asked: the same id as the shell's `subject`. */
  readonly ferretId: string;
  /** The accounts the DAEMON offered here and the place and project it resolved: handles, labels and keys only. */
  readonly saved: InputSaved;
  /** The daemon may have typed the first code, or the offers moved: the card reads its request again. */
  readonly refresh: () => void;
  /** The panel is offering something that must stay on screen (`true`) or is done (`false`): the card keeps its view. */
  readonly hold?: (holding: boolean) => void;
}

/**
 * The props of a codes slot, read by the panel that fills it: props are untrusted at the slot (the shell does not read
 * them), so a filler refuses anything that is not the shape above. `undefined` is "draw nothing", never a throw.
 */
export function readInputCardCodesSlotProps(props: unknown): InputCardCodesSlotProps | undefined {
  if (typeof props !== 'object' || props === null) return undefined;
  const candidate = props as Record<string, unknown>;
  const { requestId, ferretId, saved, refresh, hold } = candidate;
  if (typeof requestId !== 'string' || requestId === '') return undefined;
  if (typeof ferretId !== 'string' || ferretId === '') return undefined;
  // The same schema the daemon's request is read with: a filler never believes a shape the wire would refuse.
  const read = InputSavedSchema.safeParse(saved);
  if (!read.success) return undefined;
  if (typeof refresh !== 'function') return undefined;
  if (hold !== undefined && typeof hold !== 'function') return undefined;
  return {
    requestId,
    ferretId,
    saved: read.data,
    refresh: refresh as () => void,
    ...(hold === undefined ? {} : { hold: hold as (holding: boolean) => void }),
  };
}
