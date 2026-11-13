/**
 * The host the Warden's one Actions row ("Ask the Warden to investigate now…") draws its form in: what the form may
 * ask of the surface around it. The Actions menu itself is Ferrets'; the row reaches it through its
 * `ferrets.actions-row` slot (views/warden-ferret.tsx).
 */

export interface FerretActionFormHost {
  readonly close: () => void;
  readonly open: (actionId: string) => void;
  readonly notify: (sentence: string) => void;
  readonly compact: boolean;
}
