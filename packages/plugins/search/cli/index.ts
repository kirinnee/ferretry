import { implementCli } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';

/** Search (cli half): no verb. Every subsystem ships three halves, so this is the empty one. */
export default implementCli(manifest, { build: () => ({ verbs: {} }) });
