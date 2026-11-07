import { err, ok, type Result } from '@ferretry/std';
import type { JsonlRecords, StateDamage, StateFileDef } from '../../contract/index.ts';
import { damageOf, decodeJson, describeFault, openDocument, shapeOf } from './format.ts';
import type { HostFs } from './host-fs.ts';
import { scanJsonl } from './jsonl-scan.ts';
import { checkSqlite, type SqliteFiles } from './sqlite-store.ts';

/**
 * Reading one declared file with its format check — no policy applied. The port turns a damage into an error or a
 * narrower reading; boot (`openPluginState`) only wants the damage.
 */

/** A JSON document: `undefined` when the file does not exist and is not `required`. */
export async function readJsonDocument<Shape>(
  fs: HostFs,
  def: StateFileDef<string, Shape>,
  path: string,
  label: string,
): Promise<Result<Shape | undefined, StateDamage>> {
  let text: string | undefined;
  try {
    text = await fs.readText(path);
  } catch (error) {
    return err(damageOf(label, 'io', describeFault(error)));
  }
  if (text === undefined) return def.required === true ? err(damageOf(label, 'missing')) : ok(undefined);
  return decodeJson(def, label, text);
}

/** A JSONL file's records, format by format. A torn last line is ignored; any other bad line damages the file. */
export async function readJsonlRecords<Shape>(
  fs: HostFs,
  def: StateFileDef<string, Shape>,
  path: string,
  label: string,
): Promise<Result<readonly Shape[], StateDamage>> {
  let bytes: Uint8Array | undefined;
  try {
    bytes = await fs.readBytes(path);
  } catch (error) {
    return err(damageOf(label, 'io', describeFault(error)));
  }
  if (bytes === undefined) return def.required === true ? err(damageOf(label, 'missing')) : ok([]);
  const scan = scanJsonl(bytes);
  const problem = scan.problems[0];
  if (problem !== undefined) return err(damageOf(label, 'unparsable', `line ${problem.line}: ${problem.message}`));
  const shapes: Shape[] = [];
  for (const record of scan.records) {
    const opened = openDocument(def, `${label} line ${record.line}`, record.value);
    if (!opened.ok) return err({ ...opened.error, file: label });
    const shape = shapeOf(def, `${label} line ${record.line}`, opened.value);
    if (!shape.ok) return err({ ...shape.error, file: label });
    shapes.push(shape.value);
  }
  return ok(shapes);
}

/**
 * A JSONL file's records line by line: a line that does not parse or check is counted in `unreadable` and skipped.
 * With `maxBytes`, only the end of the file is read, and a line the window cut at its start is dropped. Only an io
 * fault (or a `required` file that is missing) is a damage.
 */
export async function readJsonlLines<Shape>(
  fs: HostFs,
  def: StateFileDef<string, Shape>,
  path: string,
  label: string,
  maxBytes?: number,
): Promise<Result<JsonlRecords<Shape>, StateDamage>> {
  let bytes: Uint8Array | undefined;
  try {
    if (maxBytes === undefined) bytes = await fs.readBytes(path);
    else {
      const tail = await fs.readTail(path, maxBytes);
      if (tail !== undefined) {
        const firstBreak = tail.from === 0 ? -1 : tail.bytes.indexOf(0x0a);
        bytes = tail.from === 0 ? tail.bytes : firstBreak < 0 ? new Uint8Array() : tail.bytes.subarray(firstBreak + 1);
      }
    }
  } catch (error) {
    return err(damageOf(label, 'io', describeFault(error)));
  }
  if (bytes === undefined)
    return def.required === true ? err(damageOf(label, 'missing')) : ok({ records: [], unreadable: 0 });
  const scan = scanJsonl(bytes);
  let unreadable = scan.problems.length;
  const records: Shape[] = [];
  for (const record of scan.records) {
    const opened = openDocument(def, `${label} line ${record.line}`, record.value);
    const shape = opened.ok ? shapeOf(def, `${label} line ${record.line}`, opened.value) : opened;
    if (shape.ok) records.push(shape.value);
    else unreadable += 1;
  }
  return ok({ records, unreadable });
}

/** Opaque bytes (`secret`, `opaque`): present or not, never parsed. */
export async function readBytesFile(
  fs: HostFs,
  def: StateFileDef,
  path: string,
  label: string,
): Promise<Result<Uint8Array | undefined, StateDamage>> {
  try {
    const bytes = await fs.readBytes(path);
    if (bytes === undefined && def.required === true) return err(damageOf(label, 'missing'));
    return ok(bytes);
  } catch (error) {
    return err(damageOf(label, 'io', describeFault(error)));
  }
}

/** Whatever is wrong with one file on disk, or `undefined`: what boot asks of each declared file. */
export async function inspectStateFile(
  fs: HostFs,
  def: StateFileDef,
  path: string,
  label: string,
  sqliteFiles: SqliteFiles,
): Promise<StateDamage | undefined> {
  switch (def.store) {
    case 'json': {
      const read = await readJsonDocument(fs, def, path, label);
      return read.ok ? undefined : read.error;
    }
    case 'jsonl': {
      const read = await readJsonlRecords(fs, def, path, label);
      return read.ok ? undefined : read.error;
    }
    case 'sqlite': {
      if ((await fs.info(path)) === undefined) return def.required === true ? damageOf(label, 'missing') : undefined;
      return checkSqlite(def, path, label, sqliteFiles);
    }
    case 'sqlite-cache':
      return undefined;
    case 'secret':
    case 'opaque': {
      // Presence only: a secret is never read just to be checked.
      try {
        const info = await fs.info(path);
        return info === undefined && def.required === true ? damageOf(label, 'missing') : undefined;
      } catch (error) {
        return damageOf(label, 'io', describeFault(error));
      }
    }
  }
}
