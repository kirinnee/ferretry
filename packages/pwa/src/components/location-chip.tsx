/**
 * A shared location, drawn twice: as the pending chip above the message box while the reader is still
 * deciding, and as the read-only chip inside a sent message.
 *
 * The chip is a drawing of text the message already carries (`lib/location-share.ts`), so removing it
 * or reading it never involves the position again. Colours are theme tokens only.
 */

import { LoaderCircle, MapPin, RotateCw, X } from 'lucide-react';
import { useDeviceFacts } from '../hooks/use-device-permissions.ts';
import { howToEnable } from '../lib/device-permissions.ts';
import { accuracyLabel, coordinatePair, type LocationError, type LocationFix } from '../lib/location-share.ts';

/** Where a pending share stands. `null` (no chip) is the resting state, held by the composer. */
export type LocationDraft =
  | { readonly kind: 'locating' }
  | { readonly kind: 'ready'; readonly fix: LocationFix }
  | { readonly kind: 'failed'; readonly error: LocationError };

const CHIP =
  'flex flex-col gap-1 rounded-control border border-border bg-surface-2 px-control-x py-2 text-ui leading-base text-fg';

/** The fix as it reads in a sent message. */
export function LocationChip({ fix }: { readonly fix: LocationFix }) {
  return (
    <span
      className={`${CHIP} my-1 w-fit max-w-full`}
      data-location-chip=""
      title={new Date(fix.capturedAt).toISOString()}
    >
      <span className="flex items-center gap-2 font-semibold">
        <MapPin size={16} className="shrink-0 text-accent" aria-hidden="true" />
        {fix.place === undefined ? 'Shared location' : fix.place}
      </span>
      <span className="font-mono text-meta text-muted">{coordinatePair(fix)}</span>
      <span className="text-meta text-faint">{accuracyLabel(fix.accuracyMeters)}</span>
    </span>
  );
}

export interface PendingLocationChipProps {
  readonly draft: LocationDraft;
  readonly disabled?: boolean;
  readonly onPlace: (place: string) => void;
  readonly onRemove: () => void;
  readonly onRetry: () => void;
}

export function PendingLocationChip({ draft, disabled = false, onPlace, onRemove, onRetry }: PendingLocationChipProps) {
  const facts = useDeviceFacts();
  const remove = (
    <button
      type="button"
      aria-label="Remove the shared location"
      className="fy-composer-icon shrink-0"
      disabled={disabled}
      onClick={onRemove}
    >
      <X size={16} aria-hidden="true" />
    </button>
  );

  if (draft.kind === 'locating') {
    return (
      <div className={CHIP} data-location-draft="locating" role="status">
        <span className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-muted">
            <LoaderCircle size={16} className="shrink-0 animate-spin" aria-hidden="true" />
            Finding your location…
          </span>
          {remove}
        </span>
      </div>
    );
  }

  if (draft.kind === 'failed') {
    return (
      <div className={CHIP} data-location-draft="failed" role="alert">
        <span className="flex items-start justify-between gap-2">
          <span className="text-err">{draft.error.message}</span>
          {remove}
        </span>
        {draft.error.code === 'denied' ? (
          <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-meta leading-base text-muted">
            {howToEnable('location', facts).map(step => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        ) : null}
        {draft.error.code === 'unsupported' ? null : (
          <button
            type="button"
            className="inline-flex min-h-[44px] items-center gap-1 self-start rounded-control px-2 text-ui font-semibold text-accent hover:bg-accent-soft"
            disabled={disabled}
            onClick={onRetry}
          >
            <RotateCw size={14} aria-hidden="true" />
            Try again
          </button>
        )}
      </div>
    );
  }

  const { fix } = draft;
  return (
    <div className={CHIP} data-location-draft="ready" data-location-chip="">
      <span className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-semibold">
          <MapPin size={16} className="shrink-0 text-accent" aria-hidden="true" />
          Sharing your location
        </span>
        {remove}
      </span>
      <span className="font-mono text-meta text-muted">{coordinatePair(fix)}</span>
      <span className="text-meta text-faint">{accuracyLabel(fix.accuracyMeters)} — sent once, with this message.</span>
      <label className="flex flex-col gap-1 text-meta text-muted">
        Place name (optional)
        <input
          className="h-control w-full rounded-control border border-border bg-surface px-control-x text-ui text-fg placeholder:text-faint focus:border-accent"
          disabled={disabled}
          maxLength={80}
          onChange={event => onPlace(event.currentTarget.value)}
          placeholder="Home, the office…"
          value={fix.place ?? ''}
        />
      </label>
    </div>
  );
}
