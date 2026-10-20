import { readlink, realpath } from 'node:fs/promises';
import type { Harness, HarnessInstallFacts } from '@ferretry/protocol';
import type { HarnessFactsSource } from '../../lib/index.ts';
import { executableNixFacts, type FactCommandResult, runBounded } from './install-facts.ts';

export interface HostHarnessFactsSeams {
  readonly homeDirectory: string;
  readonly platform: string;
  readonly run?: (argv: readonly string[], timeoutMs: number) => Promise<FactCommandResult | undefined>;
  readonly realpath?: (path: string) => Promise<string>;
  readonly readLink?: (path: string) => Promise<string | undefined>;
}

/**
 * The facts about the file a runtime launches for one harness — read EXACTLY as the daemon reads its
 * own (`executableNixFacts`): its resolved path, its link chain, and the nix profile element that holds
 * it. `launchedPath` is what `locateHarnessCommand` chose, which is what the wrapper `exec`s.
 */
export class HostHarnessFacts implements HarnessFactsSource {
  private readonly run: NonNullable<HostHarnessFactsSeams['run']>;
  private readonly resolveLink: NonNullable<HostHarnessFactsSeams['realpath']>;
  private readonly readLink: NonNullable<HostHarnessFactsSeams['readLink']>;

  constructor(private readonly seams: HostHarnessFactsSeams) {
    this.run = seams.run ?? runBounded;
    this.resolveLink = seams.realpath ?? (async path => await realpath(path));
    this.readLink = seams.readLink ?? (async path => await readlink(path).catch(() => undefined));
  }

  async facts(harness: Harness, launchedPath: string): Promise<HarnessInstallFacts> {
    const resolvedPath = await this.resolveLink(launchedPath).catch(() => launchedPath);
    const nix = await executableNixFacts(launchedPath, resolvedPath, { run: this.run, readLink: this.readLink });
    return {
      harness,
      launchedPath,
      resolvedPath,
      homeDirectory: this.seams.homeDirectory,
      platform: this.seams.platform,
      ...nix,
    };
  }
}
