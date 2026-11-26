/**
 * WHAT THE INPUT CARD DRAWS FOR A CODE FERRETRY MAKES (docs/input-requests.md, "Codes Ferretry makes", "In the app").
 *
 * An offer that carries `codes` is an account whose 2FA seed Ferretry holds. It is drawn as one button per key, in the
 * order the daemon sent them, instead of one "use saved" button. A tap hands the account's handle, its sign-in and the
 * KEY's id to the card; the daemon makes the code inside its use boundary and types it, so nothing here ever holds a
 * code, a seed or a password, and there is nothing to echo.
 *
 * {@link CodesSlot} is the place Accounts draws "Set up automatic codes" (`contract/input-card-slots.ts`). The card never
 * knows what draws there.
 */
import { useEffect, useRef } from 'react';
import { PanelSlot, useOptionalRouter } from '@ferretry/app';
import { INPUT_CARD_CODES_SLOT, type InputCardCodesSlotProps, type InputSavedOffer } from '../../../contract/index.ts';
import {
  codeButtonWords,
  codeCheckedWords,
  offerElsewhereWords,
  offerWhyWords,
  offerWords,
} from '../../lib/input-card.ts';
import type { InputCodeKey } from '../../../contract/index.ts';

interface CodeButtonsProps {
  readonly offer: InputSavedOffer;
  readonly keys: readonly InputCodeKey[];
  readonly disabled: boolean;
  /** One tap on one key: the key's id. */
  readonly onUse: (factor: string) => void;
}

/** ONE ACCOUNT that makes codes: its name and why it is offered, then a button for each key it can make a code from. */
export function CodeButtons({ offer, keys, disabled, onUse }: CodeButtonsProps) {
  const detail = [offerWhyWords(offer), offerElsewhereWords(offer)].filter(each => each !== undefined).join(' · ');
  const primary = offer.primary === true;
  return (
    <div
      className={`flex min-w-0 flex-col gap-2 rounded-panel border bg-surface-2 p-panel ${primary ? 'border-accent' : 'border-border-strong'}`}
      data-input-offer-codes={offer.id}
      data-input-primary={primary ? '' : undefined}
    >
      <span className="block min-w-0 break-words font-medium text-fg" data-input-offer-name="">
        {offerWords(offer)}
      </span>
      {detail === '' ? null : (
        <span className="block min-w-0 break-words text-meta text-muted" data-input-offer-detail="">
          {detail}
        </span>
      )}
      {keys.map(key => {
        const checked = codeCheckedWords(key);
        return (
          <button
            aria-label={`${codeButtonWords(key)} for ${offerWords(offer)}`}
            className="flex min-h-[44px] w-full min-w-0 flex-col items-start gap-0.5 rounded-control border border-border-strong bg-surface px-3 py-2 text-left text-fg"
            data-input-code-key={key.factor}
            disabled={disabled}
            key={key.factor}
            onClick={event => {
              // Only the first click of a gesture is a choice (see the plain offer button).
              if (event.detail > 1) return;
              onUse(key.factor);
            }}
            type="button"
          >
            <span className="block min-w-0 break-words text-left font-medium">{codeButtonWords(key)}</span>
            {checked === undefined ? null : (
              <span
                className={`block min-w-0 break-words text-left text-meta font-normal ${key.checked === 'failed' ? 'text-warn' : 'text-muted'}`}
                data-input-code-checked={key.checked}
              >
                {checked}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Mounts whatever panels any plugin contributes to the codes slot, handed the ids the card holds and no value. */
export function CodesSlot({ slot }: { readonly slot: InputCardCodesSlotProps }) {
  useLetGoOnUnmount(slot.hold);
  const router = useOptionalRouter();
  const daemon = router?.route.kind === 'screen' ? router.route.daemon : undefined;
  if (daemon === undefined) return null;
  return (
    <div data-input-codes-slot="">
      <PanelSlot daemon={daemon} props={{ ...slot }} slot={INPUT_CARD_CODES_SLOT} subject={slot.ferretId} />
    </div>
  );
}

/**
 * A panel that said `hold(true)` must not keep the card holding once its slot is gone (the card stopped offering it, or
 * the card went away): the slot's own unmount says `hold(false)` for it.
 */
export function useLetGoOnUnmount(hold: ((holding: boolean) => void) | undefined): void {
  const latest = useRef(hold);
  latest.current = hold;
  useEffect(
    () => () => {
      latest.current?.(false);
    },
    [],
  );
}
