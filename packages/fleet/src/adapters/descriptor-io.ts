import { close, fstat, fsync, read, type Stats, write } from 'node:fs';
import { promisify } from 'node:util';

/**
 * Reads, writes, syncs and closes on a raw descriptor — OFF the event loop.
 *
 * WHY. These run inside the daemon, and every synchronous file call there holds the one thread that answers
 * every client. On a disk saturated by swap an `fsync` measured 38 s, and on 2026-11-05 the conversation lease
 * scan's `readSync`s were the second-hottest frame of the stalls the daemon had while its disk was CALM. The
 * callback forms run on the runtime's I/O threads, so the loop keeps answering while the disk is slow.
 *
 * DESCRIPTORS ONLY, NEVER A PATH. The macOS descriptor bracket (`descriptor-calls.ts`) installs a held folder as
 * the process's working directory for one synchronous call, and an asynchronous call on a RELATIVE path that was
 * still in flight on an I/O thread could resolve inside it. A descriptor resolves nothing, so none of these can.
 */

const fstatAsync = promisify(fstat);
const readAsync = promisify(read);
const writeAsync = promisify(write);
const fsyncAsync = promisify(fsync);
const closeAsync = promisify(close);

/** The descriptor's own status — of whatever it is open on, never of a path. */
export async function fstatOf(descriptor: number): Promise<Stats> {
  return await fstatAsync(descriptor);
}

/**
 * Up to `length` bytes into `buffer` at `offset`, read at `position` (`null`: the descriptor's own offset).
 * Resolves the count read; 0 is the end of the file.
 */
export async function readInto(
  descriptor: number,
  buffer: Uint8Array,
  offset: number,
  length: number,
  position: number | null,
): Promise<number> {
  const { bytesRead } = await readAsync(descriptor, buffer, offset, length, position);
  return bytesRead;
}

/** Every byte, at the descriptor's offset (or its end when it was opened to append). */
export async function writeAllTo(descriptor: number, bytes: Uint8Array): Promise<void> {
  for (let written = 0; written < bytes.byteLength; ) {
    const { bytesWritten } = await writeAsync(descriptor, bytes, written, bytes.byteLength - written);
    written += bytesWritten;
  }
}

/** The descriptor's data and metadata on stable storage. */
export async function syncDescriptor(descriptor: number): Promise<void> {
  await fsyncAsync(descriptor);
}

/** Closes the descriptor. */
export async function closeDescriptor(descriptor: number): Promise<void> {
  await closeAsync(descriptor);
}
