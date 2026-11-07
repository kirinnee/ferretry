import { skeletonDaemon } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';

/**
 * Skeleton daemon half (§10.3): listed in ports-pending.json until the port lands. Its `approvedProjectServers` is
 * `codexProjectApprovals` (`lib/project-approvals.ts`), always `not-taken`. MCP does not ask it: it answers
 * `not-taken` for a Codex launch itself, whatever state this half is in, so a Codex launch is handed no project server
 * and renews none, which is today's behaviour too.
 */
export default skeletonDaemon(manifest);
