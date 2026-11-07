import { skeletonDaemon } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';

/**
 * Skeleton daemon half (§10.3): listed in ports-pending.json until the port lands.
 *
 * GAP (until then): `approvedProjectServers` is written and tested (`lib/project-approvals.ts`) but not served — a
 * skeleton provides nothing, so MCP's optional use of this port is unbound and MCP binds no project server (fail
 * closed). The port binds it as `new ClaudeProjectApprovals(ferret => kernel.roots.root('agent-homes',
 * { subfolder: ferret }))`: this plugin's own home root, never MCP's.
 */
export default skeletonDaemon(manifest);
