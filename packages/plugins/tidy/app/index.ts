import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { tidySettings } from './surfaces.tsx';

/** Tidy's app half (§2.3): the Tidy settings tab. */
export default implementApp(manifest, {
  build: ({ client }) => ({ settings: { tidy: tidySettings(client) } }),
});
