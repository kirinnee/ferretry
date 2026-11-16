import { implementCli } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';

/**
 * Warden (cli half): there is no `fy warden` verb today and none is declared (the manifest says so), so this half
 * implements nothing and says it. The Warden is read and changed through the app and the nine routes; a verb arrives
 * with its own manifest line, not here first.
 */
export default implementCli(manifest, { build: () => ({}) });
