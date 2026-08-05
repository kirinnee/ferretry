import type { IFyApiClient, SecretList, SecretSummary, SecretUseRequest, SecretUseResult } from '@ferretry/protocol';

/**
 * Presentation for the secret commands.
 *
 * `raw` is separate from `success` on purpose: `use` relays a child's own output, which must reach
 * the caller byte-for-byte and uncoloured — an agent piping `fy secret use -- curl …` into `jq` gets
 * exactly what `curl` wrote, minus any masked value.
 */
export interface ISecretOutput {
  success(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
  /** Writes a child's stream through verbatim. */
  raw(stream: 'stdout' | 'stderr', text: string): void;
}

/**
 * Where a secret VALUE comes from when one is being stored.
 *
 * Never argv. A value on the command line is in the shell history of whoever typed it and in
 * `/proc/<pid>/cmdline` for every account on the box for as long as the command runs — which is
 * exactly the disclosure this store exists to stop. So the value arrives on stdin, and the command
 * that would accept it as an argument does not exist.
 */
export interface ISecretValueSource {
  read(): Promise<string>;
}

/**
 * The daemon calls the secret commands need.
 *
 * NOTE WHAT IS MISSING: there is no `get`. Not because the CLI chose not to expose one, but because
 * the daemon serves no route that could answer it. `use` is how a value is spent.
 */
export interface ISecretGateway {
  list(): Promise<SecretList>;
  put(name: string, value: string): Promise<SecretSummary>;
  remove(name: string): Promise<void>;
  use(request: SecretUseRequest): Promise<SecretUseResult>;
}

/** The only client capability the secret gateway consumes. */
export type SecretApiClient = Pick<IFyApiClient, 'request'>;
