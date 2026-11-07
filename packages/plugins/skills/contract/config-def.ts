import type { ConfigDef } from '@ferretry/kernel/contract';

/**
 * The leaf's `ConfigDef` (= `ConfigDef<unknown>`) does not accept a typed `defineConfig(...)` result, because
 * `Loosens<Shape>` is invariant in `Shape`. `manifest.data.config` wants `ConfigDef[]`, so a contract widens its defs
 * through this. REMOVE when the kernel leaf takes `Loosens<any>` (announced by the kernel slice).
 */
export function configDef(def: ConfigDef<any>): ConfigDef {
  return def as ConfigDef;
}
