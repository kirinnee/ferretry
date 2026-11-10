import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { ConversationPort } from '../../contract/index.ts';

/**
 * A stand-in for Ferretry's Warden: a plugin with the Warden's real manifest id that needs the Conversation port, so a
 * test takes the port AS the Warden (`host.provided(ConversationPort, 'warden')`) the way the kernel builds it for that
 * plugin. The id is written out here, not read from the constant under test.
 */
export const wardenStandIn = implementDaemon(
  definePlugin({
    id: 'warden',
    title: 'Warden (fake)',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    needs: { conversation: ConversationPort },
  }),
  { build: () => ({}) },
);
