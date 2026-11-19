import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';

/**
 * PRs & CI (app half): nothing is drawn yet. Every subsystem ships three halves, so this is the empty one; E3 and the
 * units after it add the screens.
 */
export default implementApp(manifest, { build: () => ({}) });
