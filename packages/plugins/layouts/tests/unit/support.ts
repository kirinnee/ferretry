/** An in-memory config tree: a `ConfigPort` over documents, writing with the kernel's real `ConfigWriteOutcome`s. */
import type {
  ConfigCollectionDef,
  ConfigEdit,
  ConfigFileDef,
  ConfigPort,
  ConfigWriteOutcome,
} from '@ferretry/kernel/contract';

type Def = ConfigFileDef<any> | ConfigCollectionDef<any>;

export interface Tree {
  readonly port: ConfigPort;
  /** Every write and remove, in order. */
  readonly calls: { readonly op: 'write' | 'remove'; readonly where: string; readonly edit?: ConfigEdit }[];
  /** The raw documents by `file` or `collection/name`. */
  readonly documents: Map<string, Record<string, unknown>>;
}

const keyOf = (def: Def, name: string | undefined): string =>
  def.shape === 'file' ? def.file : `${def.collection}/${name ?? ''}`;

/** The kernel's refusal for a text that does not check: it names the problem and never quotes a value. */
export const refusing = (message: string): ConfigWriteOutcome => ({
  kind: 'refused',
  reason: 'schema',
  issues: [{ path: 'density', message }],
});

/**
 * `forced`: the outcome EVERY write and remove answers with, nothing stored (a refusal, a hold for the owner, a
 * conflict); left out, a write is stored and answers `written`, as the kernel's does for an edit that checks.
 */
export function configTree(initial: Record<string, Record<string, unknown>> = {}, forced?: ConfigWriteOutcome): Tree {
  const documents = new Map(Object.entries(initial));
  const calls: Tree['calls'][number][] = [];
  const port: ConfigPort = {
    file: def => {
      const raw = def.shape === 'file' ? documents.get(def.file) : undefined;
      return raw === undefined ? undefined : def.schema.parse(raw);
    },
    collection: def => {
      const out = new Map<string, any>();
      const prefix = def.shape === 'collection' ? `${def.collection}/` : '';
      for (const [key, raw] of documents)
        if (prefix !== '' && key.startsWith(prefix)) out.set(key.slice(prefix.length), def.schema.parse(raw));
      return out;
    },
    watch: () => () => {},
    watchState: () => () => {},
    etag: async () => 'absent',
    fileState: () => ({ state: 'absent', inEffect: false, sentences: [] }),
    async write(def, name, edit): Promise<ConfigWriteOutcome> {
      calls.push({ op: 'write', where: keyOf(def, name), edit });
      if (forced !== undefined) return forced;
      const where = keyOf(def, name);
      const patch = typeof edit === 'string' ? (Bun.YAML.parse(edit) as Record<string, unknown>) : edit.patch;
      const next = typeof edit === 'string' ? { ...patch } : { ...documents.get(where) };
      if (typeof edit !== 'string')
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) delete next[key];
          else next[key] = value;
        }
      documents.set(where, next);
      return { kind: 'written', etag: `etag-${calls.length}`, loosened: [] };
    },
    async writeAsOwner(def, name, edit, options): Promise<ConfigWriteOutcome> {
      return await this.write(def, name, edit, options);
    },
    async writeAsCaller(def, name, edit, options): Promise<ConfigWriteOutcome> {
      return await this.write(def, name, edit, options);
    },
    // This plugin writes one file at a time; a set is not part of what these tests stand in for.
    async writeAll() {
      return { kind: 'refused', reason: 'not_declared', issues: [] };
    },
    async remove(def, name): Promise<ConfigWriteOutcome> {
      calls.push({ op: 'remove', where: keyOf(def, name) });
      if (forced !== undefined) return forced;
      documents.delete(keyOf(def, name));
      return { kind: 'written', etag: `etag-${calls.length}`, loosened: [] };
    },
  };
  return { port, calls, documents };
}
