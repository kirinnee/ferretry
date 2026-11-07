import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';

/** Asks' app half: Asks puts nothing in the app. The Agenda plugin is how the owner sees and answers asks (§2.2). */
export default implementApp(manifest, { build: () => ({}) });
