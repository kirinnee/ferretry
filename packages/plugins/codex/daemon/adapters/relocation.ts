/** Packing a Codex conversation to travel to another machine, and unpacking it into the new ferret's home there. */
import type { Harness, LaunchSpec } from '@ferretry/core-ferrets/contract';
import { MAX_ROOT_WINDOW_BYTES, type FerretId, type KernelPorts, type RootHandle } from '@ferretry/kernel/contract';
import { err, ok, type Result } from '@ferretry/std';
import {
  relocateRollout,
  renamedRolloutPath,
  rolloutFolder,
  rolloutPathId,
  type Relocated,
} from '../lib/relocation.ts';
import type { CodexRollouts } from './rollouts.ts';

/** The most of a conversation one move carries: a rollout is held whole in memory, as a copy and a fork hold it. */
const MAX_PACK_BYTES = 256 * 1024 * 1024;
const HOME_RELATIVE = /(sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl)$/u;
const decoder = new TextDecoder();
const NOT_POOLED = 'this ferret’s sessions link does not lead to this machine’s history pool, so nothing was written';

type Refusal = { readonly reason: string };
const refuse = (reason: string): Result<never, Refusal> => err({ reason });

/** What the relocation needs of the harness around it: its rollouts, the ferret's home, and the shared history pool. */
export interface RelocationParts {
  readonly kernel: Pick<KernelPorts, 'roots' | 'clock'>;
  readonly rollouts: CodexRollouts;
  readonly ensureHome: (spec: LaunchSpec) => Promise<RootHandle>;
  readonly homeOf: (ferret: FerretId) => string;
  readonly poolHistory: (ferret: FerretId) => Promise<string | undefined>;
}

/** The id the header of a rollout names, or `undefined` when its first lines carry none. */
function headerId(text: string): string | undefined {
  for (const line of text.split('\n').slice(0, 8)) {
    try {
      const event = JSON.parse(line) as { type?: unknown; payload?: { id?: unknown } };
      if (event.type === 'session_meta' && typeof event.payload?.id === 'string') return event.payload.id;
    } catch {
      /* An incomplete header is not identity evidence. */
    }
  }
  return undefined;
}

export class CodexRelocation {
  constructor(private readonly parts: RelocationParts) {}

  /**
   * `Harness.packConversation`: the ferret's PROVED rollout, byte for byte, read through the held no-link handle the
   * transcript reader uses (never a pathname, so a file swapped in after the proof is never handed over). Nothing is
   * written. A conversation that could not be unpacked on the other machine is refused HERE, before anything stops.
   */
  readonly pack: NonNullable<Harness['packConversation']> = async ferret => {
    const { rollouts } = this.parts;
    const handle = await rollouts.bytes(ferret).catch(() => undefined);
    if (handle === undefined)
      return refuse('this ferret has no conversation of its own yet, so there is nothing to move');
    let bytes: Uint8Array;
    try {
      if (handle.size > MAX_PACK_BYTES) return refuse('the conversation is too large to move (over 256 MB)');
      bytes = new Uint8Array(handle.size);
      let offset = 0;
      while (offset < handle.size) {
        const chunk = await handle.read(offset, Math.min(MAX_ROOT_WINDOW_BYTES, handle.size - offset));
        if (chunk.length === 0) return refuse('the conversation shrank while it was being read');
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      if ((await handle.stat())?.size !== handle.size)
        return refuse('the conversation changed while it was being read');
    } catch {
      return refuse('the conversation could not be read');
    } finally {
      await handle.close();
    }
    const stamp = await rollouts.stamp(ferret).catch(() => undefined);
    const relPath = stamp === undefined ? undefined : HOME_RELATIVE.exec(stamp.file)?.[1];
    const text = decoder.decode(bytes);
    const id = headerId(text);
    if (relPath === undefined || id === undefined || rolloutPathId(relPath) !== id)
      return refuse('the conversation file is not one Ferretry can place on another machine');
    // The same judgement the other machine will make, made now: nothing is stopped for a conversation it would refuse.
    const probe = relocateRollout(text, { folder: '/probe', home: '/probe' });
    if (probe.kind === 'refused') return refuse(probe.reason);
    return ok({ bytes, relPath });
  };

  /**
   * `Harness.unpackConversation`: writes `packed` into THIS ferret's home as a rollout that keeps its id (a new one only
   * when this machine already holds a conversation of that id), with the work folder, the self ids and the source's
   * correlation marker moved to the new ferret's. Everything is judged before anything is written: a version Ferretry has
   * not tested, a conversation that leans on a subagent, a path that is not a rollout's — each refuses with nothing
   * written. It proves `hasConversation` before it answers, and takes the file back if that does not hold.
   */
  readonly unpack: NonNullable<Harness['unpackConversation']> = async (spec, packed) => {
    const { rollouts } = this.parts;
    const named = rolloutPathId(packed.relPath);
    if (named === undefined) return refuse('that is not a Codex rollout file path');
    if (packed.bytes.length > MAX_PACK_BYTES) return refuse('the conversation is too large to move (over 256 MB)');
    const source = decoder.decode(packed.bytes);
    if (headerId(source) !== named) return refuse('the conversation file does not belong to the conversation it names');
    const folder = String(spec.folder);
    const home = String(this.parts.homeOf(spec.ferret));
    const kept = relocateRollout(source, { folder, home });
    if (kept.kind === 'refused') return refuse(kept.reason);
    try {
      // A `sessions` link that leads anywhere but this daemon's pool: a write through it would be found by nothing. It
      // refuses HERE, before the home is prepared or poolHistory moves the home's own history into the shared pool.
      if ((await rollouts.sessionsLink(spec.ferret)) === 'stale') return refuse(NOT_POOLED);
      await this.parts.ensureHome(spec);
      await this.parts.poolHistory(spec.ferret);
      if ((await rollouts.sessionsLink(spec.ferret)) === 'stale') return refuse(NOT_POOLED);
      const root = await this.target(spec.ferret);
      let moved: Extract<Relocated, { kind: 'moved' }> = kept;
      let path = packed.relPath;
      let place = root.resolve(path);
      if (!place.ok) return refuse('the conversation cannot be placed in this ferret’s home');
      // The same id anywhere in the history the ferret resumes from — under whatever file name — is the same conversation.
      const held = await rollouts.filesOf(spec.ferret, named);
      if (held === undefined) return refuse('this ferret’s history could not be searched, so nothing was written');
      const filed = place.value;
      if (held.some(file => file !== filed))
        return refuse(
          'this machine already holds a conversation with that id under another file name, so it was not moved',
        );
      if (held.length > 0 || (await root.lstat(place.value)) !== undefined) {
        // This machine already holds a conversation of that id (a ferret moved back here): the move takes a new one.
        const id = crypto.randomUUID();
        const fresh = relocateRollout(source, { folder, home, id });
        if (fresh.kind === 'refused') return refuse(fresh.reason);
        moved = fresh;
        path = renamedRolloutPath(packed.relPath, named, id);
        place = root.resolve(path);
        if (!place.ok) return refuse('the conversation cannot be placed in this ferret’s home');
      }
      const directory = root.resolve(rolloutFolder(path));
      if (!directory.ok) return refuse('the conversation cannot be placed in this ferret’s home');
      await root.makeDirectory(directory.value, { mode: 0o700 });
      await root.writeBytes(place.value, new TextEncoder().encode(moved.text), { exclusive: true });
      // The one file Codex will resolve for the id must be the one just written (never an older copy).
      const resolved = await rollouts.filesOf(spec.ferret, moved.id);
      if (
        resolved?.length !== 1 ||
        resolved[0] !== place.value ||
        (await rollouts.has(spec.ferret, moved.id)) !== true
      ) {
        await root.unlink(place.value).catch(() => undefined);
        return refuse(
          'the conversation was written, but Codex would not find it from this ferret’s home, so it was taken back',
        );
      }
      return ok({ conversation: moved.id });
    } catch {
      return refuse('the conversation could not be written into this ferret’s home');
    }
  };

  /**
   * Where this ferret's rollouts are filed: the shared pool when its `sessions` is the link to it (the usual case), else
   * its own `sessions` folder (a real one), through the ferret's home root; either way the rollout path is the home-relative one.
   */
  private async target(ferret: FerretId): Promise<RootHandle> {
    const { kernel } = this.parts;
    const own = kernel.roots.root('agent-homes', { subfolder: ferret });
    const at = own.resolve('sessions');
    const linked = at.ok ? (await own.lstat(at.value).catch(() => undefined))?.kind === 'symlink' : false;
    if (linked) {
      try {
        const root = kernel.roots.historyPool();
        return root;
      } catch {
        /* a plugin with no pool files into the ferret's own folder */
      }
    }
    return own;
  }
}
