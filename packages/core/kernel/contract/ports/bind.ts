/** The address of the daemon's TCP listener as it BOUND (an ephemeral `0` is the port the OS chose). */
export interface BoundAddress {
  readonly host: string;
  readonly port: number;
}

/**
 * The one fact about the listener a plugin may need: the host and port the kernel actually bound, whichever of
 * `--port`, `FY_PORT` or the default decided them. `current()` is `undefined` until the kernel has listened (plugins
 * are built BEFORE that) and again after it stops, so ask when the answer is needed, not when the plugin is built.
 */
export interface BindPort {
  current(): BoundAddress | undefined;
}
