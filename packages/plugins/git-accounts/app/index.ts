import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';

/**
 * Git accounts (app half): nothing is drawn yet. Every subsystem ships three halves, so this is the empty one; the
 * accounts screen (B2) replaces it with the Settings tab.
 */
export default implementApp(manifest, { build: () => ({}) });
