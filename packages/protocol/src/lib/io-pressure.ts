/**
 * WHETHER THE DISK IS WHY A DAEMON IS SLOW — Linux's own account, read as a pure value.
 *
 * On a box whose disk other jobs had saturated (`/proc/pressure/io`: some avg300 ≈ 51 %, full ≈ 46 %),
 * the daemon's event loop stalled for 5 to 38 seconds at a time and the app, the tunnel and the CLI all
 * looked dead. Nothing said "the disk is the problem", so the owner restarted a daemon that was only
 * waiting. The kernel's pressure-stall information (PSI) says exactly that: the share of recent time
 * tasks spent stalled on IO. This module owns the facts every reader of that number must agree on —
 * how the file parses, what counts as saturated, and the sentence a person is told — so the daemon that
 * measures it, the CLI that reads it locally and the app that shows it cannot disagree.
 *
 * PSI is absent on macOS, on kernels built without it and inside many containers; every function here
 * treats "no reading" as a first-class answer rather than as zero.
 */

import { z } from 'zod';

/** A percentage of a window, 0 to 100. */
const PercentSchema = z.number().finite().min(0).max(100);

/** One PSI line: the share of the last 10, 60 and 300 seconds spent stalled. */
export const IoPressureLineSchema = z.object({ avg10: PercentSchema, avg60: PercentSchema, avg300: PercentSchema });
export type IoPressureLine = z.infer<typeof IoPressureLineSchema>;

/**
 * One reading of `/proc/pressure/io`.
 *
 * - `some` — at least one task was stalled on IO: the disk is contended.
 * - `full` — every non-idle task was stalled at once: nothing could make progress. Absent on a kernel
 *   that reports only `some`.
 */
export interface IoPressure {
  readonly some: IoPressureLine;
  readonly full?: IoPressureLine;
}

/**
 * What a daemon reports of a reading: the last-10-second shares and the verdict, never the raw
 * windows. Optional on every wire it rides, because a daemon from before it, or one on a host without
 * PSI, sends none.
 */
export const IoPressureViewSchema = z.object({
  someAvg10: PercentSchema,
  fullAvg10: PercentSchema.optional(),
  saturated: z.boolean(),
});
export type IoPressureView = z.infer<typeof IoPressureViewSchema>;

/**
 * The share of the last ten seconds, with every non-idle task stalled on IO, at which the disk is
 * called saturated. A tenth is a full second in ten during which nothing in the process tree could run;
 * a daemon doing one fsync per write feels that as multi-second stalls, and an idle or merely busy
 * disk sits at a fraction of a percent.
 */
export const SATURATED_FULL_AVG10 = 10;

/**
 * The share of the last ten seconds, with at least one task stalled on IO, at which the disk is called
 * saturated even when `full` is absent or low. A quarter of the time spent waiting on the disk by
 * someone is well beyond what a healthy busy machine shows (single digits), and it is the signal on
 * kernels that report `some` alone.
 */
export const SATURATED_SOME_AVG10 = 25;

const LINE = /^(some|full)((?:\s+(?:avg10|avg60|avg300|total)=[0-9.]+)+)\s*$/u;

function numbersOf(fields: string): Record<string, number> {
  const values: Record<string, number> = {};
  for (const field of fields.trim().split(/\s+/u)) {
    const [name = '', value = ''] = field.split('=');
    values[name] = Number(value);
  }
  return values;
}

function lineOf(fields: Record<string, number>): IoPressureLine | undefined {
  const parsed = IoPressureLineSchema.safeParse({
    avg10: fields.avg10,
    avg60: fields.avg60,
    avg300: fields.avg300,
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * The reading in `/proc/pressure/io`'s text, or `undefined` when it holds no usable `some` line.
 *
 * Never throws: a garbled file, an empty one and a future format are all "no reading", because the
 * caller is a daemon that must not fail over a diagnostic.
 */
export function parseIoPressure(text: string): IoPressure | undefined {
  let some: IoPressureLine | undefined;
  let full: IoPressureLine | undefined;
  for (const raw of text.split('\n')) {
    const match = LINE.exec(raw.trim());
    if (match === null) continue;
    const line = lineOf(numbersOf(match[2] ?? ''));
    if (match[1] === 'some') some = line;
    else full = line;
  }
  if (some === undefined) return undefined;
  return full === undefined ? { some } : { some, full };
}

/** `'disk'` when the reading says the disk is saturated, and `undefined` when it does not — or is absent. */
export function classifyStallCause(pressure: IoPressure | undefined): 'disk' | undefined {
  if (pressure === undefined) return undefined;
  const full = pressure.full?.avg10 ?? 0;
  return full >= SATURATED_FULL_AVG10 || pressure.some.avg10 >= SATURATED_SOME_AVG10 ? 'disk' : undefined;
}

/** A reading as the wire carries it. */
export function ioPressureView(pressure: IoPressure): IoPressureView {
  return {
    someAvg10: pressure.some.avg10,
    ...(pressure.full === undefined ? {} : { fullAvg10: pressure.full.avg10 }),
    saturated: classifyStallCause(pressure) === 'disk',
  };
}

const percent = (value: number): string => `${String(Math.round(value))}%`;

/** The pressure a person is told, naming the signal that crossed its bar: `46% full` or `30% some`. */
export function describeIoPressure(io: Pick<IoPressureView, 'someAvg10' | 'fullAvg10'>): string {
  const bySome = (io.fullAvg10 ?? 0) < SATURATED_FULL_AVG10 && io.someAvg10 >= SATURATED_SOME_AVG10;
  return io.fullAvg10 === undefined || bySome ? `${percent(io.someAvg10)} some` : `${percent(io.fullAvg10)} full`;
}

/**
 * The sentence for a daemon that is slow because of the disk. It says the one thing the owner needs —
 * wait, do not restart — where "looks stalled or wedged" invites a restart that changes nothing.
 */
export function describeDiskSaturation(io: Pick<IoPressureView, 'someAvg10' | 'fullAvg10'>): string {
  return `disk is saturated (io pressure ${describeIoPressure(io)}) — the daemon is slow, not dead`;
}
