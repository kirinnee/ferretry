import { defineState } from '@ferretry/kernel/contract';

/**
 * `monitor-tick.json` (today's monitor record): what the declared-wait monitor loop last did and whether it is running,
 * published after every tick, a failed one included, so a loop that stopped never looks like a fleet with nothing parked.
 */
export const MonitorTickFile = defineState({
  name: 'monitor-tick',
  path: 'monitor-tick.json',
  store: 'json',
  format: 1,
});
