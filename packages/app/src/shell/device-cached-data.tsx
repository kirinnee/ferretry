/**
 * SETTINGS › THIS DEVICE › CACHED DATA (S-0458): what this device keeps so a screen can open where it was — today, where
 * each page was scrolled (`ScrollMemory`, this tab's own storage). It is this device's copy only: clearing it removes
 * nothing from any machine, signs nothing out and forgets no pairing; the next open starts at the top. Asked once, inline,
 * because the only cost is that. Ported from today's `features/settings/clear-cached-data.tsx`.
 *
 * The shell keeps no copy of a machine's session list or of a transcript yet (the chat's declared GAP), so there is
 * nothing of those to clear and the row does not claim them. A cache added later joins the one `clear` below.
 */

import { Check, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { SettingRow } from '../compose/setting-row.tsx';
import { Button } from '../ui/primitives.tsx';

type Phase = 'idle' | 'confirming' | 'clearing' | 'cleared' | 'failed';

export interface CachedDataSettingProps {
  /** Empties this device's copy; settles when storage has. */
  readonly onClear: () => Promise<void>;
}

export function CachedDataSetting({ onClear }: CachedDataSettingProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const clear = (): void => {
    setPhase('clearing');
    onClear().then(
      () => setPhase('cleared'),
      () => setPhase('failed'),
    );
  };
  return (
    <SettingRow
      settingId="clear-cached-data"
      name="Cached data"
      hint={
        phase === 'cleared' ? (
          <span aria-live="polite" role="status">
            <Check size={14} aria-hidden="true" className="mr-1 inline align-[-2px] text-ok" />
            Cleared
          </span>
        ) : phase === 'failed' ? (
          <span aria-live="polite" role="status">
            This browser would not clear it. Try again.
          </span>
        ) : (
          'Where each page was scrolled, kept for a fast open'
        )
      }
      explanation="What this device keeps so a screen opens where you left it. Clearing removes only this device’s copy: nothing on your machines is removed, no pairing is forgotten, and the next open starts afresh."
      dataAttributes={{ 'data-clear-cached-data': phase }}
      control={() =>
        // While asking, the question below is the control.
        phase === 'confirming' ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-[44px]"
            aria-label={phase === 'clearing' ? undefined : 'Clear cached data'}
            disabled={phase === 'clearing'}
            onClick={() => setPhase('confirming')}
          >
            {phase === 'clearing' ? 'Clearing…' : 'Clear'}
          </Button>
        )
      }
    >
      {phase === 'confirming' ? (
        <div className="flex flex-wrap items-center gap-2 px-panel pb-3">
          <span className="text-meta text-fg">Clear this device’s cached data?</span>
          <Button type="button" variant="danger" size="sm" className="min-h-[44px]" onClick={clear}>
            <Trash2 size={14} aria-hidden="true" />
            <span className="ml-1">Clear</span>
          </Button>
          <Button type="button" variant="ghost" size="sm" className="min-h-[44px]" onClick={() => setPhase('idle')}>
            Keep it
          </Button>
        </div>
      ) : null}
    </SettingRow>
  );
}
