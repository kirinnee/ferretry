import { implementCli } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';

/** Relocate (cli half): no verb. The move is the app's flow between two paired machines. Every subsystem ships three halves, so this is the empty one. */
export default implementCli(manifest, { build: () => ({ verbs: {} }) });
