/** Today's wire boundary; Access exports replace the local passkey wire when its port lands. */
export * from '../../contract/wire/index.ts';
export * from '../../contract/wire/foreign.ts';
export * from '../../contract/wire/member-passkeys.ts';
export type DaemonCarrier = import('../../contract/wire/foreign.ts').PublishedCarriers[number];
export type McpScope = 'ferretry' | 'component' | 'user' | 'project' | 'local';
export type { SessionMcpServer, SessionMcpDiffLine } from '../../contract/wire/mcp-install.ts';
export type { CatalogInstallComponent as FleetComponentInput } from '../../contract/items/index.ts';
export { STEP_UP_ACTS, STEP_UP_REQUIRED_CODE, type StepUpRequiredBody } from '@ferretry/core-gate/contract';
