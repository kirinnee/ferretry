/**
 * Settings › This device › CLEAR CACHED DATA.
 *
 * What this device keeps so a screen can draw before the network answers — each machine's session list
 * and the recent end of each opened transcript (`lib/session-cache.ts`) — plus where each page was
 * scrolled. It is this device's copy only: clearing it removes nothing from any machine, signs nothing
 * out and forgets no pairing; the next open simply reads everything afresh. Asked once, inline, because
 * the only cost is a slower next open.
 */

import { Check, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../shell/primitives.tsx';

export interface ClearCachedDataSettingProps {
  /** Empties the cache; settles when storage has. Absent where the host keeps none. */
  readonly onClear?: () => Promise<void>;
}

type Phase = 'idle' | 'confirming' | 'clearing' | 'cleared' | 'failed';

export function ClearCachedDataSetting({ onClear }: ClearCachedDataSettingProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  if (onClear === undefined)
    return <p className="m-0 text-cell leading-base text-muted">This copy of Ferretry keeps no cached data.</p>;

  const clear = (): void => {
    setPhase('clearing');
    onClear().then(
      () => setPhase('cleared'),
      () => setPhase('failed'),
    );
  };

  return (
    <div className="grid gap-2" data-clear-cached-data={phase}>
      <p className="m-0 text-cell leading-base text-muted">
        Nothing on your machines is removed and no pairing is forgotten; the next open reads everything afresh.
      </p>
      {phase === 'confirming' ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-meta text-fg">Clear this device’s cached sessions and messages?</span>
          <Button type="button" variant="danger" size="sm" className="min-h-[44px]" onClick={clear}>
            <Trash2 size={14} aria-hidden="true" />
            <span className="ml-1">Clear</span>
          </Button>
          <Button type="button" variant="ghost" size="sm" className="min-h-[44px]" onClick={() => setPhase('idle')}>
            Keep it
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-[44px]"
            disabled={phase === 'clearing'}
            onClick={() => setPhase('confirming')}
          >
            <Trash2 size={14} aria-hidden="true" />
            <span className="ml-1">{phase === 'clearing' ? 'Clearing…' : 'Clear cached data'}</span>
          </Button>
          <span aria-live="polite" className="text-meta text-muted" role="status">
            {phase === 'cleared' ? (
              <>
                <Check size={14} aria-hidden="true" className="mr-1 inline align-[-2px] text-ok" />
                Cleared
              </>
            ) : phase === 'failed' ? (
              'This browser would not clear it. Try again.'
            ) : null}
          </span>
        </div>
      )}
    </div>
  );
}
