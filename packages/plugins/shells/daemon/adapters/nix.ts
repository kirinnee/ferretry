/** `nix`, reached only through the kernel's spawn port (`permissions.spawn: ['nix']`). Every call turns on the two
 * experimental features itself, so no user configuration is needed. */
import { err, minutes, seconds } from '@ferretry/std';
import type { SpawnPort } from '@ferretry/kernel/contract';
import type { NixTool } from '../lib/nix-tool.ts';
import { parseDevEnv, parseFlakeMetadata, parseFlakeMetadataSource } from '../lib/source.ts';

const FEATURES = ['--extra-experimental-features', 'nix-command flakes'] as const;

/** The last lines of a failure, bounded, for the sentence a person reads. */
const tail = (text: string): string => text.trim().split('\n').slice(-6).join('\n').slice(-600);

export function nixTool(spawn: SpawnPort): NixTool {
  return {
    async facts() {
      try {
        const result = await spawn.run('nix', ['--version'], { timeout: seconds(10) });
        const version = /(\d+\.\d+(?:\.\d+)?\S*)/u.exec(result.stdout)?.[1];
        if (result.exitCode === 0 && version !== undefined) return { present: true, version, path: 'nix' };
      } catch {
        // not installed: said below
      }
      return {
        present: false,
        consequence: 'ferrets use the tools already on this machine',
        remedy: 'install nix to give each ferret its own shell',
      };
    },

    async flakeMetadata(reference) {
      try {
        const result = await spawn.run('nix', [...FEATURES, 'flake', 'metadata', '--json', reference], {
          timeout: minutes(2),
        });
        if (result.exitCode !== 0) return err(tail(result.stderr) || 'nix could not read it');
        const source = parseFlakeMetadataSource(result.stdout);
        if (!source.ok) return source;
        if (source.value.narHash !== undefined) return parseFlakeMetadata(result.stdout);
        // Fetch the revision metadata resolved, never the floating input a second time.
        const fetched = await spawn.run('nix', [...FEATURES, 'flake', 'prefetch', '--json', source.value.url], {
          timeout: minutes(2),
        });
        if (fetched.exitCode !== 0) return err(tail(fetched.stderr) || 'nix could not fetch it');
        let value: unknown;
        try {
          value = JSON.parse(fetched.stdout);
        } catch {
          return err('nix did not answer in JSON');
        }
        const hash = value !== null && typeof value === 'object' && 'hash' in value ? value.hash : undefined;
        return parseFlakeMetadata(result.stdout, hash);
      } catch {
        return err('nix could not be run');
      }
    },

    async devEnv(args) {
      try {
        const result = await spawn.run('nix', args, { timeout: minutes(30) });
        if (result.exitCode !== 0) return err(tail(result.stderr) || 'the build failed');
        return parseDevEnv(result.stdout);
      } catch {
        return err('nix could not be run');
      }
    },
  };
}
