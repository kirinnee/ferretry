import { skeletonDaemon } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';

/** Skeleton daemon half (§10.3): listed in ports-pending.json until the port lands. */
export default skeletonDaemon(manifest);
