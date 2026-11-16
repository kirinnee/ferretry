import { implementCli } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';

/** The Mailbox's CLI half: no verbs yet. `fy send` and `fy queue` stay Conversation's until the move (c58-m0). */
export default implementCli(manifest, { build: () => ({}) });
