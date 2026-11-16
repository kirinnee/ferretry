export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

/** Logging scoped to the subsystem. Never a secret, token or pairing code in a message or a field. */
export interface Log {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(scope: string): Log;
}
