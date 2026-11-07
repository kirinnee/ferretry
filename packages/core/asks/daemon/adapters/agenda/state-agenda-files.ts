import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import { createHash } from 'node:crypto';
import { type AgendaFileStore, isAgendaSessionId } from '../../lib/agenda/index.ts';
import type { AppendOnlyFiles } from '../../lib/append-only-log.ts';
import { AGENDA_STATE_FILES, AgendaSetAsideFiles } from '../../lib/state.ts';

/** Which declared file a name is, and under which collection name. */
interface Located {
  readonly def: StateFileDef<string, Uint8Array>;
  readonly name: string;
  /** `state/asks/…`, as an error names it. */
  readonly label: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** A file's identity is the digest of its bytes: any change to it, by anyone, is a new identity. */
const identityOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * A ferret's agenda files over the kernel's state port (`state/asks/ferrets/<ferret>/…`), byte for byte as the engine
 * wrote them — the repository's recovery compares the digests of exact texts and cuts history back to a byte cursor.
 *
 * Every write is the kernel's atomic write: a synced temporary file renamed over the target, then the folder synced.
 * An APPEND is therefore a whole new file holding the old bytes and the new ones, never a torn tail; the history is
 * appended only when items are archived, so this costs a read of it then and not on a board read. A file the engine
 * sets aside (`….stale`, `….damaged-<id>`) moves to `set-aside/<ferret>~<name>`, kept for a person to look at.
 */
export class StateAgendaFiles implements AgendaFileStore, AppendOnlyFiles {
  constructor(private readonly state: StatePort) {}

  private locate(sessionId: string, name: string): Located {
    if (!isAgendaSessionId(sessionId)) throw new Error(`not a valid agenda session id: ${sessionId}`);
    const def = (AGENDA_STATE_FILES as Readonly<Record<string, StateFileDef<string, Uint8Array>>>)[name];
    if (def !== undefined) return { def, name: sessionId, label: `state/asks/ferrets/${sessionId}/${name}` };
    const aside = `${sessionId}~${name}`;
    return { def: AgendaSetAsideFiles as StateFileDef<string, Uint8Array>, name: aside, label: `state/asks/set-aside/${aside}` };
  }

  /** Where the file is, for a sentence that names it. */
  file(sessionId: string, name: string): string {
    return this.locate(sessionId, name).label;
  }

  private async bytes(sessionId: string, name: string): Promise<Uint8Array | undefined> {
    const at = this.locate(sessionId, name);
    const read = await this.state.read(at.def, at.name);
    if (!read.ok) throw new Error(read.error.sentence);
    return read.value === undefined ? undefined : new Uint8Array(read.value);
  }

  private async put(sessionId: string, name: string, bytes: Uint8Array): Promise<void> {
    const at = this.locate(sessionId, name);
    await this.state.write(at.def, bytes, at.name);
  }

  async read(sessionId: string, name: string): Promise<string | undefined> {
    const bytes = await this.bytes(sessionId, name);
    return bytes === undefined ? undefined : decoder.decode(bytes);
  }

  async identity(sessionId: string, name: string): Promise<string | undefined> {
    const bytes = await this.bytes(sessionId, name);
    return bytes === undefined ? undefined : identityOf(bytes);
  }

  async readIdentified(
    sessionId: string,
    name: string,
  ): Promise<{ readonly text: string; readonly identity: string } | undefined> {
    // One read: the identity is of the very bytes the text came from.
    const bytes = await this.bytes(sessionId, name);
    return bytes === undefined ? undefined : { text: decoder.decode(bytes), identity: identityOf(bytes) };
  }

  async writeAtomic(sessionId: string, name: string, text: string): Promise<void> {
    await this.put(sessionId, name, encoder.encode(text));
  }

  /** Only the uncommitted suffix is handed back; offsets count UTF-8 bytes. */
  async readAfter(sessionId: string, name: string, bytes: number): Promise<Uint8Array> {
    const all = await this.bytes(sessionId, name);
    if (all === undefined) {
      if (bytes === 0) return new Uint8Array();
      throw new Error(`append cursor exceeds file: ${name}`);
    }
    if (all.length < bytes) throw new Error(`append cursor exceeds file: ${name}`);
    return all.subarray(bytes);
  }

  async appendSynced(sessionId: string, name: string, bytes: Uint8Array): Promise<void> {
    const before = (await this.bytes(sessionId, name)) ?? new Uint8Array();
    const after = new Uint8Array(before.length + bytes.length);
    after.set(before, 0);
    after.set(bytes, before.length);
    await this.put(sessionId, name, after);
  }

  async truncate(sessionId: string, name: string, bytes: number): Promise<void> {
    const all = await this.bytes(sessionId, name);
    if (all === undefined) throw new Error(`cannot cut a file that is not there: ${name}`);
    await this.put(sessionId, name, all.slice(0, bytes));
  }

  async rename(sessionId: string, from: string, to: string): Promise<void> {
    const bytes = await this.bytes(sessionId, from);
    if (bytes === undefined) throw new Error(`cannot move a file that is not there: ${from}`);
    // The copy lands before the original goes: a crash between them leaves both, never neither.
    await this.put(sessionId, to, bytes);
    await this.remove(sessionId, from);
  }

  async remove(sessionId: string, name: string): Promise<void> {
    const at = this.locate(sessionId, name);
    await this.state.remove(at.def, at.name);
  }
}
