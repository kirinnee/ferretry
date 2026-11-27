import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';

/** Relocate (app half): no screen yet; the move's row and flow arrive with the app unit. Every subsystem ships three halves, so this is the empty one. */
export default implementApp(manifest, { build: () => ({}) });
