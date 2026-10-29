/**
 * THE DISK PRESSURE OF ONE MACHINE, for the line that says "slow, not dead" (`daemon-health.ts`
 * decides what is worth saying). Read every {@link DISK_PRESSURE_REFRESH_MS} while the page is open,
 * and kept across a read that fails, because the failing read is the symptom.
 */

import { useRef } from 'react';
import type { IoPressureView } from '@ferretry/protocol';
import type { DaemonConnection } from './daemon-connection.ts';
import { diskPressureOf } from './daemon-health.ts';
import { useDaemonHealth } from './use-daemon-health.ts';

const DISK_PRESSURE_REFRESH_MS = 30_000;

export function useDiskPressure(daemon: DaemonConnection | undefined): IoPressureView | undefined {
  const read = useDaemonHealth(daemon, DISK_PRESSURE_REFRESH_MS);
  const remembered = useRef<{ readonly daemonId: string | undefined; readonly io: IoPressureView | undefined }>({
    daemonId: undefined,
    io: undefined,
  });
  const daemonId = daemon?.daemonId;
  const previous = remembered.current.daemonId === daemonId ? remembered.current.io : undefined;
  const io = diskPressureOf(read, previous);
  remembered.current = { daemonId, io };
  return io;
}
