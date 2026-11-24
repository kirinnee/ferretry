import { implementCli } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';

/** Create (cli half): no verb. Its tools are the agent's; every subsystem ships three halves, so this is the empty one. */
export default implementCli(manifest, { build: () => ({ verbs: {} }) });
