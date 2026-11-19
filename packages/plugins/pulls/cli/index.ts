import { implementCli } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';

/** PRs & CI (cli half): no verb yet. Every subsystem ships three halves, so this is the empty one. */
export default implementCli(manifest, { build: () => ({ verbs: {} }) });
