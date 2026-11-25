import { implementDaemon } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';

/**
 * Connector (daemon half): serves nothing yet. The authorization server in `lib/oauth/` is pure and is not reached from
 * here until the wiring unit gives it a door, routes and a store; until then the plugin only declares its config and state.
 */
export default implementDaemon(manifest, { build: () => ({}) });
