import type { IoPressure } from '@ferretry/protocol';

/**
 * The disk's pressure, as the last reading saw it.
 *
 * SYNCHRONOUS AND CACHED, because its reader is the event-loop meter recording a stall — code that must
 * not wait on the disk, least of all when the disk is why the loop just stalled. The adapter refreshes
 * the reading on a timer with an asynchronous read; a stall therefore sees the pressure as it was up to
 * one refresh period before the loop got to run again, which is the pressure that led into it.
 * `undefined` where the host has no pressure-stall information (macOS, old kernels, many containers).
 */
export interface IoPressurePort {
  current(): IoPressure | undefined;
}

/** No pressure information: a stall is attributed to its labelled work and stacks alone. */
export const NO_IO_PRESSURE: IoPressurePort = Object.freeze({ current: () => undefined });

/** An {@link IoPressurePort} whose reading is kept fresh from `start` until the function it returns is called. */
export interface IoPressureSourcePort extends IoPressurePort {
  start(): () => void;
}
