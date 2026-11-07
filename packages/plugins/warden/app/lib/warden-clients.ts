/**
 * The factory a Warden view provides: the client of the daemon the view is on is the one this half was handed, and
 * any other paired daemon's comes from the shell (`pluginClientFor`).
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import { type DaemonConnection, pluginClientFor } from '../shell.ts';
import { wardenClientOf } from './warden-client.ts';
import type { WardenClientFactory } from './warden-client-context.tsx';

export const wardenClientFactory =
  (home: DaemonConnection, client: PluginClient): WardenClientFactory =>
  async connection =>
    wardenClientOf(connection.daemonId === home.daemonId ? client : await pluginClientFor(connection, client));
