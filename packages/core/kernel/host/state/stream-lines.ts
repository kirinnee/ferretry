import { err, ok, type Result } from '@ferretry/std';
import type { StateDamage, StateFileDef } from '../../contract/index.ts';
import { damageOf, describeFault, openDocument, shapeOf } from './format.ts';
import type { HostFs } from './host-fs.ts';
import { JsonlScanner, MAX_JSONL_RECORD_BYTES } from './jsonl-scan.ts';

/** A journal is read this much at a time; a piece grows to hold one whole record (up to the record cap). */
export const JSONL_CHUNK_BYTES = 256 * 1024;

/** Thrown into the file read to end it when the reader stopped asking; never escapes. */
const STOPPED = Symbol('jsonl stream stopped');

/**
 * A JSONL file's records as they are read, line by line, holding one piece of the file and the records of that piece:
 * a journal of any size costs the same. Same verdict per line as `readJsonlLines`: a line that does not parse or check
 * is counted and skipped, a torn last line is neither; only an io fault or a missing `required` file is a damage.
 *
 * The generator RETURNS (what a `for await` does not show) the count of skipped lines, or the damage that ended the
 * read: records already yielded stand. Stopping early (`return()`) ends the file read and closes its handle.
 *
 * `HostFs.streamBytes` pushes pieces; this turns it into a pull by holding the push until the records of the piece in
 * hand are taken, so the file is read only as fast as the reader consumes it.
 */
export async function* streamJsonlLines<Shape>(
  fs: HostFs,
  def: StateFileDef<string, Shape>,
  path: string,
  label: string,
): AsyncGenerator<Shape, Result<number, StateDamage>, undefined> {
  const pending: Shape[] = [];
  let unreadable = 0;
  let finished = false;
  let stopped = false;
  let fault: unknown;
  let found = false;
  let wake: (() => void) | undefined;
  let resume: (() => void) | undefined;

  const scanner = new JsonlScanner({
    record: record => {
      const at = `${label} line ${record.line}`;
      const opened = openDocument(def, at, record.value);
      const shape = opened.ok ? shapeOf(def, at, opened.value) : opened;
      if (shape.ok) pending.push(shape.value);
      else unreadable += 1;
    },
    problem: () => {
      unreadable += 1;
    },
    tornTail: () => undefined,
  });

  const reading = fs
    .streamBytes(
      path,
      JSONL_CHUNK_BYTES,
      async chunk => {
        if (stopped) throw STOPPED;
        scanner.push(chunk);
        if (pending.length === 0) return;
        // Hold the file here until the reader has taken this piece's records.
        wake?.();
        await new Promise<void>(release => {
          resume = release;
        });
        if (stopped) throw STOPPED;
      },
      MAX_JSONL_RECORD_BYTES,
    )
    .then(opened => {
      found = opened;
      if (opened) scanner.end();
    })
    .catch((error: unknown) => {
      if (error !== STOPPED) fault = error;
    })
    .finally(() => {
      finished = true;
      wake?.();
    });

  try {
    for (;;) {
      if (pending.length > 0) {
        for (const shape of pending.splice(0)) yield shape;
        resume?.();
        resume = undefined;
        continue;
      }
      if (finished) break;
      await new Promise<void>(notify => {
        wake = notify;
      });
    }
  } finally {
    stopped = true;
    resume?.();
    await reading;
  }
  if (fault !== undefined) return err(damageOf(label, 'io', describeFault(fault)));
  if (!found) return def.required === true ? err(damageOf(label, 'missing')) : ok(0);
  return ok(unreadable);
}
