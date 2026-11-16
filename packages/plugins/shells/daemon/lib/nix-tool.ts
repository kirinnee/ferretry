/** The Nix boundary used by the service; its process adapter implements this interface. */
import type { Result } from '@ferretry/std';
import type { NixFacts } from '../../contract/index.ts';
import type { FlakeFacts } from './source.ts';

export interface NixTool {
  facts(): Promise<NixFacts>;
  flakeMetadata(reference: string): Promise<Result<FlakeFacts, string>>;
  /** Builds the shell and answers its environment. `args` are the arguments after `nix`. */
  devEnv(args: readonly string[]): Promise<Result<Readonly<Record<string, string>>, string>>;
}
