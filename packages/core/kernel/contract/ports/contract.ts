/** Which hash of its own contract a plugin asks for: the whole effective surface (absent) or its member table only. */
export type ContractSurface = 'member';

/**
 * The contract hash of the plugin that holds this port. With no argument it is the effective hash: the one value
 * `GET /v1/plugins` shows for it. `hash('member')` is the hash over its member-table routes only (§9.6), so a change to
 * its owner routes does not move it; a plugin that declares no member routes has none and the call throws. It takes no
 * id, so a plugin can read its own hash and never another package's (no inventory leak).
 */
export interface ContractPort {
  hash(surface?: ContractSurface): string;
}
