/**
 * The one door a plugin writes its own `config/` files through (§7.2: the kernel's config service checks the schema,
 * holds a loosening and keeps the comments). The leaf's `ConfigPort` (read + watch) does not carry it yet, so the
 * daemon half takes it from the port when the host provides it and answers the write routes
 * `503 shell_config_unavailable` when it does not: the reads still work.
 */
import type { ConfigCollectionDef, ConfigFileDef, ConfigPort } from '@ferretry/kernel/contract';

/** A whole new text, or a patch of top-level keys (an `undefined` value removes the key). */
export type ConfigEdit = string | { readonly patch: Readonly<Record<string, unknown>> };

export type DoorResult =
  | { readonly kind: 'applied' }
  | { readonly kind: 'held'; readonly sentences: readonly string[] }
  | { readonly kind: 'refused'; readonly reason: string; readonly issues: readonly { readonly message: string }[] };

export interface ConfigDoor {
  write(
    def: ConfigFileDef<any> | ConfigCollectionDef<any>,
    name: string | undefined,
    edit: ConfigEdit,
  ): Promise<DoorResult>;
  remove(def: ConfigFileDef<any> | ConfigCollectionDef<any>, name: string | undefined): Promise<DoorResult>;
}

/** The door the host's config port carries, if it carries one. */
export function configDoorOf(port: ConfigPort): ConfigDoor | undefined {
  const maybe = port as ConfigPort & Partial<ConfigDoor>;
  const { write, remove } = maybe;
  if (typeof write !== 'function' || typeof remove !== 'function') return undefined;
  return {
    write: (def, name, edit) => write.call(port, def, name, edit),
    remove: (def, name) => remove.call(port, def, name),
  };
}
