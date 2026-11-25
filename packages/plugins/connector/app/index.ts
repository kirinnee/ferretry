import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';

/** Connector (app half): no screen yet; the settings panel arrives with its own unit. Every subsystem ships three halves, so this is the empty one. */
export default implementApp(manifest, { build: () => ({}) });
