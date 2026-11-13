/**
 * The permission card's panel above the composer (slot `conversation.above-composer`, the ferret as its `subject`). It
 * reads what the ferret is stopped on from the daemon's prompt route and draws the card for a tool-permission prompt,
 * and nothing otherwise. The card (`./prompt-cards.tsx`) answers through the existing permission route.
 */

import type { AppComponent, PanelProps } from '@ferretry/kernel/manifest';
import type { ClaudeCodeClient } from '../lib/client.ts';
import { PermissionCard } from './prompt-cards.tsx';
import { useStoppedOn } from './use-stopped-on.ts';

export const createPanel = (client: ClaudeCodeClient): AppComponent<PanelProps> =>
  function PermissionPanel({ subject }: PanelProps) {
    const { stoppedOn, agentName, refresh } = useStoppedOn(client, subject);
    if (subject === undefined || stoppedOn.permission === undefined) return null;
    return (
      <PermissionCard
        agentName={agentName}
        client={client}
        ferret={subject}
        key={stoppedOn.permission.id}
        onSettled={refresh}
        request={stoppedOn.permission}
      />
    );
  };
