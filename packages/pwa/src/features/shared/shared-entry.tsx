/**
 * A way into Shared with me from the screens that name no machine. Drawn only when this browser holds
 * at least one key, so a person who was never shared anything is never shown a door to an empty room.
 */

import { useEffect, useState } from 'react';
import { Button } from '../../shell/primitives.tsx';
import type { SharedController } from './shared-controller.ts';
import { SEE_SHARED, SHARED_ENTRY_NOTE } from './shared-screens-model.ts';

type SharedEntryPort = Pick<SharedController, 'list'>;

/** Whether this browser belongs to any publisher. `false` until the answer is known. */
function useHasShared(members: SharedEntryPort): boolean {
  const [has, setHas] = useState(false);
  useEffect(() => {
    let live = true;
    void members
      .list()
      .then(subs => {
        if (live) setHas(subs.length > 0);
      })
      .catch(() => {
        if (live) setHas(false);
      });
    return () => {
      live = false;
    };
  }, [members]);
  return has;
}

export function SharedEntry({ members, onOpen }: { readonly members: SharedEntryPort; readonly onOpen: () => void }) {
  if (!useHasShared(members)) return null;
  return (
    <div className="mx-auto flex w-full max-w-[680px] flex-col items-start gap-xs px-3 pb-4" data-shared-entry="">
      <p className="m-0 text-cell text-muted">{SHARED_ENTRY_NOTE}</p>
      <Button type="button" onClick={onOpen}>
        {SEE_SHARED}
      </Button>
    </div>
  );
}
