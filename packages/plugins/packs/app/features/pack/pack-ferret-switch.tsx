/**
 * PACK MODE ON ONE FERRET: a "Pack mode" switch beside the ferret, and the polite status line that says what the switch did
 * (docs/pack-mode.md).
 *
 * The switch decides only what the ferret is TOLD — that it may delegate to helpers and pick the model each runs on. Its
 * instructions were fixed when it started, so a change takes effect at its next launch and nothing is sent to it; the
 * daemon's own `note` says so, and the host shows it. The machine's own switch and the depth limit still apply on top of it.
 *
 * The daemon has no read of one ferret's switch yet (PENDING.md, "One ferret's own switch"), so the state shown is
 * the answer the daemon last gave on this page, and ON — what absent means — until then. The answer is kept, so the toggle
 * never flips back under the reader.
 */

import { X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { type PacksClient, refusalSentence } from '../../lib/client.ts';
import { patchFerretPack } from '../../lib/pack-api.ts';
import { cn } from '../../ui.ts';

export interface PackFerretSwitch {
  /** What the last press came to, to render with `PackNote` beside the switch. */
  readonly note: string | null;
  readonly dismiss: () => void;
  /** Whether one ferret may delegate, with the answer the daemon last gave. */
  readonly onFor: (ferretId: string) => boolean;
  /** Switches one ferret. A refusal is said in the same status line as the answer. */
  readonly tap: (ferretId: string, next: boolean) => Promise<void>;
}

/** The polite status line that says what the switch did. */
export function PackNote({ note, dismiss }: { readonly note: string | null; readonly dismiss: () => void }) {
  if (note === null) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-pack-action-note=""
      className="flex max-w-[480px] items-center gap-2 rounded-control border border-accent-border bg-surface px-3 py-1 text-ui text-fg shadow-popover"
    >
      <span className="min-w-0 flex-1">{note}</span>
      <button type="button" className="kt-btn h-11 w-11 shrink-0 p-0" aria-label="Dismiss" onClick={dismiss}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

export function usePackFerretSwitch({ client }: { readonly client: PacksClient }): PackFerretSwitch {
  const [note, setNote] = useState<string | null>(null);
  const [answered, setAnswered] = useState<ReadonlyMap<string, boolean>>(new Map());

  const onFor = useCallback((ferretId: string) => answered.get(ferretId) ?? true, [answered]);

  const tap = useCallback(
    async (ferretId: string, next: boolean) => {
      setNote(null);
      try {
        const result = await patchFerretPack(client, ferretId, next);
        setAnswered(current => new Map(current).set(ferretId, next));
        setNote(result.note);
      } catch (reason) {
        setNote(`Pack mode could not be switched: ${refusalSentence(reason)}`);
      }
    },
    [client],
  );

  const dismiss = useCallback(() => setNote(null), []);
  return { note, dismiss, onFor, tap };
}

/** The switch: one checkbox row, labelled by what it decides. */
export function PackSwitchRow({
  ferretId,
  control,
}: {
  readonly ferretId: string;
  readonly control: PackFerretSwitch;
}) {
  const on = control.onFor(ferretId);
  return (
    <label
      className={cn('flex min-h-[44px] cursor-pointer items-center gap-2 text-ui', on ? 'text-fg' : 'text-muted')}
      data-pack-ferret-switch=""
    >
      <input
        type="checkbox"
        role="switch"
        aria-checked={on}
        checked={on}
        onChange={event => void control.tap(ferretId, event.currentTarget.checked)}
      />
      <span>Pack mode</span>
      <span className="text-meta text-faint">{on ? 'On · next launch' : 'Off · next launch'}</span>
    </label>
  );
}
