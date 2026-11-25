import { implementCli } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';

/** Connector (cli half): no verb yet; `fy connector` arrives with the wiring unit. Every subsystem ships three halves, so this is the empty one. */
export default implementCli(manifest, { build: () => ({ verbs: {} }) });
