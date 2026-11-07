import type { FencedPath, RootHandle } from '@ferretry/kernel/contract';
import type { ConversationFileEntry, ConversationFiles } from '../lib/conversation-describer.ts';

/**
 * The read-only `ConversationFiles` port over the `harness-history` root (G162: transcripts of other tools are read in
 * place, never written). Paths are relative to the root, so a harness's home is a folder name there. The root offers whole
 * or prefix reads only, so a tail is a prefix read to the file's end and a slice of it.
 */
export function conversationFiles(root: RootHandle): ConversationFiles {
  const fenced = (relative: string): FencedPath | undefined => {
    const resolved = root.resolve(relative);
    return resolved.ok ? resolved.value : undefined;
  };
  const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8').decode(bytes);
  return {
    async entries(directory): Promise<readonly ConversationFileEntry[]> {
      const path = fenced(directory);
      if (path === undefined) return [];
      const names = await root.list(path).catch((): readonly string[] => []);
      const entries: ConversationFileEntry[] = [];
      for (const name of names) {
        const child = fenced(`${directory}/${name}`);
        const stat = child === undefined ? undefined : await root.stat(child).catch(() => undefined);
        entries.push({ name, kind: stat === undefined ? 'other' : stat.kind });
      }
      return entries;
    },
    async info(file) {
      const path = fenced(file);
      const stat = path === undefined ? undefined : await root.stat(path).catch(() => undefined);
      if (stat === undefined || stat.kind !== 'file') return undefined;
      return { modifiedAtMs: Date.parse(stat.modified), size: stat.size };
    },
    async head(file, maxBytes) {
      const path = fenced(file);
      if (path === undefined) return undefined;
      return await root.readBytes(path, maxBytes).then(decode, () => undefined);
    },
    async tail(file, maxBytes) {
      const path = fenced(file);
      if (path === undefined) return undefined;
      const stat = await root.stat(path).catch(() => undefined);
      if (stat === undefined) return undefined;
      const bytes = await root.readBytes(path, stat.size).catch(() => undefined);
      return bytes === undefined ? undefined : decode(bytes.subarray(Math.max(0, bytes.byteLength - maxBytes)));
    },
  };
}
