import type { PluginClient } from '@ferretry/kernel/manifest';

/** The one daemon call the terminal-slot verbs need: a declared route, through the plugin's client. */
export type ITerminalSlotsGateway = Pick<PluginClient, 'call'>;
