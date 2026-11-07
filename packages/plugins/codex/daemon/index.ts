import { skeletonDaemon } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';

/**
 * Skeleton daemon half (§10.3): listed in ports-pending.json until the port lands. Its `approvedProjectServers` is
 * `codexProjectApprovals` (`lib/project-approvals.ts`), always `not-taken`; until the port serves it, MCP's optional
 * use is unbound and a Codex launch is handed no project server, which is today's behaviour too.
 */
export default skeletonDaemon(manifest);
