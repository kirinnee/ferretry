import { implementCli } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';

export default implementCli(manifest, { build: () => ({}) });
