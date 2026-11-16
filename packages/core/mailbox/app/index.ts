import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';

/** The Mailbox's app half: nothing yet. The queue screens stay Conversation's until the move (c58-m0). */
export default implementApp(manifest, { build: () => ({}) });
