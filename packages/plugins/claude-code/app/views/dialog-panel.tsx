/**
 * The harness-dialog card's panel above the composer (slot `conversation.above-composer`, the ferret as its `subject`).
 * It reads what the ferret is stopped on from the daemon's prompt route and draws the card for one of the harness's own
 * dialogs, and nothing otherwise. The card (`./prompt-cards.tsx`) answers through the existing dialog route.
 */

import type { AppComponent, PanelProps } from '@ferretry/kernel/manifest';
import type { ClaudeCodeClient } from '../lib/client.ts';
import { DialogCard } from './prompt-cards.tsx';
import { useStoppedOn } from './use-stopped-on.ts';

export const createPanel = (client: ClaudeCodeClient): AppComponent<PanelProps> =>
  function DialogPanel({ subject }: PanelProps) {
    const { stoppedOn, agentName, refresh } = useStoppedOn(client, subject);
    if (subject === undefined || stoppedOn.dialog === undefined) return null;
    return (
      <DialogCard
        agentName={agentName}
        client={client}
        dialog={stoppedOn.dialog}
        ferret={subject}
        key={stoppedOn.dialog.id}
        onSettled={refresh}
      />
    );
  };
