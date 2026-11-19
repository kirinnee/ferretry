/**
 * THE GIT ACCOUNTS APP HALF'S SHELL SEAM: the one capability its calls consume, the machine's plugin client, by route
 * key. The client is built per machine, so nothing in this half is cached at module scope.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';

export type GitAccountsClient = Pick<PluginClient, 'call'>;
