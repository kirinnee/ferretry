/**
 * A port this plugin only `uses`, read so that "not bound yet" is an absent port.
 *
 * `ctx.uses.<name>.current()` answers `undefined` for a plugin that is off, but while THIS plugin is still building the
 * kernel throws instead ("an optional port is unbound during build"). Ferrets announces every ferret's state as the
 * daemon comes up, so a subscriber that reads the port (a ferret ended: let go of its copies) runs inside that window; a
 * throw there fails the whole subscriber and skips whatever it settles after the read. Every secure-copy port is looked up
 * on use (`./index.ts`'s callers), and an absent one copies and pastes nothing, so absent is the honest answer.
 */
export function absentWhileUnbound<T>(read: () => T | undefined): () => T | undefined {
  return () => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
}
