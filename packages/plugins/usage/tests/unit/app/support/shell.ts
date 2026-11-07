/**
 * What the old PWA tests took from the PWA's library, over the 5.0 shell adapter (`app/shell.ts`). A daemon is
 * its id only now (the client the shell builds is already that daemon's), so `daemonConnection` keeps accepting the
 * address and device fields the old suites passed and drops them.
 */
import { DaemonCallError, type DaemonConnection, type DaemonId } from '../../../../app/shell.ts';

export type { DaemonConnection, DaemonId };
export { DaemonCallError, daemonSessionScope } from '../../../../app/shell.ts';

export const daemonId = (value: string): DaemonId => value;

export const daemonConnection = (input: {
  readonly daemonId: string;
  readonly baseUrl?: string;
  readonly deviceId?: string;
  readonly label?: string;
}): DaemonConnection => ({ daemonId: input.daemonId });

/** A refused call as the shell's client throws it (`DaemonCallError`), built the way the old suites built theirs. */
export class DaemonResponseError extends DaemonCallError {
  constructor(status: number, message: string, code?: string) {
    super(status, code ?? `http_${String(status)}`, message);
  }
}

/** The old HTTP client's error, `(message, status, code)`, as the shell's `DaemonCallError`. */
export class FyHttpError extends DaemonCallError {
  constructor(message: string, status: number, code?: string) {
    super(status, code ?? `http_${String(status)}`, message);
  }
}
