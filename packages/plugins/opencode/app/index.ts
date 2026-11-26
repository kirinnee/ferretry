import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';

export default implementApp(manifest, { build: () => ({}) });
