/**
 * THE SLOT THE INPUT CARD OFFERS ONCE IT HAS SETTLED (§5.2: plugin screens offer their own, named `<plugin>.<name>`).
 *
 * After the owner taps a saved account on an input card and the daemon has typed it, the card is settled. What to offer
 * next ("Don't ask again for this sign-in", a standing rule) is ACCOUNTS' to say, and the Vault must not know how it is
 * drawn or what it writes. So the card OFFERS this slot and mounts whatever panels any installed plugin contributes to
 * it (Accounts contributes its sign-in rule sheet); neither half imports the other. A daemon without Accounts shows the
 * settled card with no extra line, and Accounts without this card shows nothing extra.
 *
 * The props are plain data: ids and names the owner already saw on the card (an account's handle, a sign-in's id, the
 * place the daemon matched, the project it resolved), never a value and never a label a ferret wrote. The slot is
 * offered ONLY after a saved account was tapped: a typed value, a paste or a refusal offers nothing here.
 */
export const INPUT_SETTLED_SLOT = 'vault.input-settled' as const;

/** What the settled card hands a panel in {@link INPUT_SETTLED_SLOT}, beside the shell's `subject` (the ferret). */
export interface InputSettledSlotProps {
  /** The ferret that asked: the same id as the shell's `subject`. */
  readonly ferret: string;
  /** The request that settled (its id), so a panel can tell one card from the next. */
  readonly request: string;
  /** The saved account the owner tapped: its handle. */
  readonly entry: string;
  /** The sign-in of that account the tap used, when it named one. */
  readonly signIn?: string;
  /** What the daemon matched the target to (`github.com`, `sudo@kirin-box`), when it worked one out. */
  readonly place?: string;
  /** The board project the DAEMON resolved for the asking session, when it did. */
  readonly project?: { readonly id: string; readonly name: string };
  /** The tapped account was already that project's default (the daemon's one-tap choice, for the `project` reason). */
  readonly projectDefault?: true;
  /**
   * A panel here is still offering something (`true`) or is done (`false`): while any is, the card keeps the view it is
   * drawn in instead of letting its host move on. Optional: a panel that offers nothing to wait for never calls it.
   */
  readonly hold?: (holding: boolean) => void;
}

export function isInputSettledSlotProps(props: unknown): props is InputSettledSlotProps {
  if (typeof props !== 'object' || props === null) return false;
  const candidate = props as Record<string, unknown>;
  return (
    typeof candidate.ferret === 'string' && typeof candidate.request === 'string' && typeof candidate.entry === 'string'
  );
}
