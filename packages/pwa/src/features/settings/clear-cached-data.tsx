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
import { SettingRow } from './setting-row.tsx';
import { settingDefinition } from './settings-catalog.ts';

export interface ClearCachedDataSettingProps {
  /** Empties the cache; settles when storage has. Absent where the host keeps none. */
  readonly onClear?: () => Promise<void>;
}

type Phase = 'idle' | 'confirming' | 'clearing' | 'cleared' | 'failed';

export function ClearCachedDataSetting({ onClear }: ClearCachedDataSettingProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  if (onClear === undefined)
    return (
      <SettingRow settingId="clear-cached-data" name="Cached data" hint="This copy of Ferretry keeps no cached data." />
    );

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
          'Sessions and recent messages kept for a fast open'
        )
      }
      explanation={`${settingDefinition('clear-cached-data').description} Nothing on your machines is removed and no pairing is forgotten; the next open reads everything afresh.`}
      dataAttributes={{ 'data-clear-cached-data': phase }}
      control={() =>
        // While asking, the question below is the control, as it was before the row was compact.
        phase === 'confirming' ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-[44px]"
            aria-label="Clear cached data"
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
          <span className="text-meta text-fg">Clear this device’s cached sessions and messages?</span>
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
