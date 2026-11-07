import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';

/**
 * The Ferrets app half (§2.2). Its screens, panels and settings tabs are the ported pages under this folder: the
 * ferret list (`components/sessions-page.tsx`), a ferret's workspace and info panel (`features/session-info/`),
 * new ferret (`components/new-session-page.tsx`), machine home (`components/machine-home.tsx`), Settings ›
 * Machines (`features/fleet/shell/machines-surface.tsx`) and the limits and agent-CLI settings
 * (`features/settings/`). Each is bound here once the manifest declares its `screen`/`panel`/`settingsTab` entry;
 * the manifest declares none yet, so the half answers an empty set.
 */
export default implementApp(manifest, {
  build: () => ({}),
});
