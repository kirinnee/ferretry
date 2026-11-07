/** An in-memory config tree: a `ConfigPort` and a door over the same documents, for tests of the service. */
import type { ConfigCollectionDef, ConfigFileDef, ConfigPort } from '@ferretry/kernel/contract';
import type { ConfigDoor, ConfigEdit, DoorResult } from '../../daemon/lib/config-door.ts';

type Def = ConfigFileDef<any> | ConfigCollectionDef<any>;

export interface Tree {
  readonly port: ConfigPort;
  readonly door: ConfigDoor;
  /** Every door call, in order. */
  readonly calls: { readonly op: 'write' | 'remove'; readonly where: string; readonly edit?: ConfigEdit }[];
  /** The raw documents by `file` or `collection/name`. */
  readonly documents: Map<string, Record<string, unknown>>;
}

const keyOf = (def: Def, name: string | undefined): string =>
  def.shape === 'file' ? def.file : `${def.collection}/${name ?? ''}`;

export function configTree(initial: Record<string, Record<string, unknown>> = {}, refuse?: string): Tree {
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
  };
  const door: ConfigDoor = {
    async write(def, name, edit): Promise<DoorResult> {
      calls.push({ op: 'write', where: keyOf(def, name), edit });
      if (refuse !== undefined) return { kind: 'refused', reason: 'schema', issues: [{ message: refuse }] };
      const where = keyOf(def, name);
      const patch = typeof edit === 'string' ? (Bun.YAML.parse(edit) as Record<string, unknown>) : edit.patch;
      const next = typeof edit === 'string' ? { ...patch } : { ...documents.get(where) };
      if (typeof edit !== 'string')
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) delete next[key];
          else next[key] = value;
        }
      documents.set(where, next);
      return { kind: 'applied' };
    },
    async remove(def, name): Promise<DoorResult> {
      calls.push({ op: 'remove', where: keyOf(def, name) });
      documents.delete(keyOf(def, name));
      return { kind: 'applied' };
    },
  };
  return { port, door, calls, documents };
}
