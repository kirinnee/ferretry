import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';

/** Create (app half): no screen yet. Its tools are the agent's; every subsystem ships three halves, so this is the empty one. */
export default implementApp(manifest, { build: () => ({}) });
