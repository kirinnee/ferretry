import { link, mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { HarnessSchema } from '@ferretry/protocol/session-base';
// The modules these come from, not the `lib` barrel: importing the barrel loaded the whole daemon, ~200 MB.
import {
  type ConversationLinker,
  type ConversationLinkOutcome,
  conversationLinkFailure,
} from '../../lib/imports/conversation-adoption.ts';
import { type ConversationOwners, conversationKey } from '../../lib/imports/conversations.ts';
import { storedTranscriptProvenance } from '../session/transcript/storage-transcript-provenance.ts';
import type { DaemonStorage } from '../storage/session-storage.ts';

export { NodeConversationFiles } from './node-conversation-file-reader.ts';

const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;

/**
 * Makes a conversation visible in a runtime's history with a HARD link: one file, two names.
 *
 * Not a copy, so the CLI appends to the owner's own file and Chat reads the same bytes. Not a symbolic
 * link, so the name inside the state home resolves inside it (the state home refuses links that
 * leave it). The cost is that both names must be on one disk, which is refused in words.
 */
export class NodeConversationLinker implements ConversationLinker {
  async link(source: string, runtimeHome: string, relativePath: string): Promise<ConversationLinkOutcome> {
    const destination = join(runtimeHome, relativePath);
    const existing = await stat(destination).catch(() => undefined);
    if (existing !== undefined) {
      const original = await stat(source);
      return existing.ino === original.ino && existing.dev === original.dev
        ? { kind: 'present' }
        : { kind: 'conflict', reason: 'The runtime already has a different conversation file with this id.' };
    }
    // The runtime's history folders are links into the shared pool, so the folder is created where
    // the link leads: in the pool, beside every other runtime's conversations.
    const folder = await realpath(join(runtimeHome, relativePath.split(sep)[0] ?? relativePath)).catch(() => undefined);
    if (folder === undefined)
      return { kind: 'unavailable', reason: 'The runtime has no history folder yet; start it once, then try again.' };
    try {
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await link(source, destination);
      return { kind: 'linked' };
    } catch (error) {
      return conversationLinkFailure(errorCode(error));
    }
  }
}

/** Which conversation each session keeps, read from the transcript record every session carries. */
export class StorageConversationOwners implements ConversationOwners {
  constructor(private readonly storage: DaemonStorage) {}

  async owners(): Promise<ReadonlyMap<string, string>> {
    const owned = new Map<string, string>();
    for (const { id } of this.storage.listSessions()) {
      const config: unknown = await this.storage.readConfig(id).catch(() => undefined);
      const harness = HarnessSchema.safeParse(
        typeof config === 'object' && config !== null ? (config as { readonly harness?: unknown }).harness : undefined,
      );
      const conversation = storedTranscriptProvenance(config)?.harnessSessionId;
      if (harness.success && conversation !== undefined) owned.set(conversationKey(harness.data, conversation), id);
    }
    return owned;
  }
}
