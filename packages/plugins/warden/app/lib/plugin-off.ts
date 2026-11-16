/** Whether a read failed because the plugin that owns the route is paused or off on that daemon (not unreadable). */

import { DaemonCallError } from '@ferretry/app';
import { KERNEL_REFUSALS } from '@ferretry/kernel/contract';

export const isPluginOff = (cause: unknown): boolean =>
  cause instanceof DaemonCallError && cause.code === KERNEL_REFUSALS.pluginPaused.code;
