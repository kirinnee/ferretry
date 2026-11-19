import type { ConfigCollectionDef, ConfigFileDef, ConfigPort } from '@ferretry/kernel/contract';

/** A patch of top-level keys: an `undefined` value removes the key. */
type DoorResult =
  | { readonly kind: 'applied' }
  | { readonly kind: 'held'; readonly sentences: readonly string[] }
  | { readonly kind: 'refused'; readonly reason: string; readonly issues: readonly { readonly message: string }[] };

export interface ConfigDoor {
  write(
    def: ConfigFileDef<any> | ConfigCollectionDef<any>,
    name: string | undefined,
    edit: { readonly patch: Readonly<Record<string, unknown>> },
  ): Promise<DoorResult>;
}

/**
 * The door a plugin writes its own `config/` file through (the kernel checks the schema, holds a loosening and keeps the
 * comments). The leaf's `ConfigPort` reads and watches; the write is there when the host provides it, and the route says
 * 503 when it does not (the reads still work). Same shape as Updates' door; it is not shared because one folder owns it.
 */
export function configDoorOf(port: ConfigPort): ConfigDoor | undefined {
  const maybe = port as ConfigPort & Partial<ConfigDoor>;
  const { write } = maybe;
  if (typeof write !== 'function') return undefined;
  return { write: (def, name, edit) => write.call(port, def, name, edit) };
}
