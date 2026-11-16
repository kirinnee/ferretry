import type { OpaqueId } from '../act.ts';

/** The kernel's id factory (§4.7): the only source of an `OpaqueId` a write-only act may hand back. */
export interface IdsPort {
  mint(prefix: string): OpaqueId;
}
