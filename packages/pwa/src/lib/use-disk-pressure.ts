/**
 * THE DISK PRESSURE OF ONE MACHINE, for the line that says "slow, not dead" (`daemon-health.ts`
 * decides what is worth saying).
 *
 * Read like any health read — on a machine change and when the page returns to the foreground — and,
 * only WHILE the disk is reported saturated, again every {@link DISK_PRESSURE_REFRESH_MS} so the line
 * leaves when the disk calms. A healthy idle page makes no extra request: the idle request budget
 * (`idle-request-budget.test.tsx`) is the reason this is not a plain poll. The last report is kept across a read
 * that fails, because the failing read is the symptom.
 */

import type { IoPressureView } from '@ferretry/protocol';
import { useRef } from 'react';
import type { DaemonConnection } from './daemon-connection.ts';
import { diskPressureOf } from './daemon-health.ts';
import { useDaemonHealth } from './use-daemon-health.ts';

const DISK_PRESSURE_REFRESH_MS = 30_000;

export function useDiskPressure(daemon: DaemonConnection | undefined): IoPressureView | undefined {
  const remembered = useRef<{ readonly daemonId: string | undefined; readonly io: IoPressureView | undefined }>({
    daemonId: undefined,
    io: undefined,
  });
  const daemonId = daemon?.daemonId;
  const previous = remembered.current.daemonId === daemonId ? remembered.current.io : undefined;
  const read = useDaemonHealth(daemon, previous === undefined ? undefined : DISK_PRESSURE_REFRESH_MS);
  const io = diskPressureOf(read, previous);
  remembered.current = { daemonId, io };
  return io;
}
