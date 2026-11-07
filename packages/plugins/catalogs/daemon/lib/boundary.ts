/** Today's wire boundary; Access exports replace the local passkey wire when its port lands. */
export * from '../../contract/wire/index.ts';
export * from '../../contract/wire/foreign.ts';
export * from '../../contract/wire/member-passkeys.ts';
export type DaemonCarrier = import('../../contract/wire/foreign.ts').PublishedCarriers[number];
export type McpScope = 'ferretry' | 'component' | 'user' | 'project' | 'local';
