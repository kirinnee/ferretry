import { implementCli } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';

/**
 * Asks' CLI half: Asks declares no verbs. Today's `fy agenda …` verbs are the Agenda plugin's (the view of asks), and
 * `fy ask` is the shell's own (§1.4); both speak Asks' routes.
 */
export default implementCli(manifest, { build: () => ({}) });
