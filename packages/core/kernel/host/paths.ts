import { err, ok, type Result } from '@ferretry/std';
import { isAbsolute } from 'node:path';
import type { CheckedDirectory, DirectoryRefusal, PathsPort } from '../contract/ports.ts';
import type { HostFs } from './adapters/node-fs.ts';
import { mayReadOverride } from './which.ts';

/**
 * `kernel.paths.checkDirectory` (today's session working-directory resolver, rule for rule): the path is trimmed; a
 * relative one is refused rather than resolved, because resolving it would silently start an agent in the DAEMON's
 * folder, which is never what the client asked for; one that does not exist, or is not a directory, is refused here
 * where the client still sees the error instead of at launch; the answer is the real path, so links and platform
 * aliases (`/tmp` and `/private/tmp`) agree with what a record stores. Read-only: it creates nothing.
 */
export async function checkDirectory(
  fs: Pick<HostFs, 'realpath' | 'identity'>,
  absolutePath: string,
): Promise<Result<CheckedDirectory, DirectoryRefusal>> {
  const requested = absolutePath.trim();
  if (!isAbsolute(requested))
    return err({
      reason: 'not_absolute',
      message: `session working directory must be absolute: ${JSON.stringify(absolutePath)}`,
    });
  const real = await fs.realpath(requested).catch(() => undefined);
  const found = real === undefined ? undefined : await fs.identity(real).catch(() => undefined);
  if (real === undefined || found?.kind !== 'directory')
    return err({ reason: 'not_a_directory', message: `session working directory is not a directory: ${requested}` });
  return ok({ realPath: real });
}

/**
 * What a plugin holds as `kernel.paths`. `checkDirectory` answers for ANY absolute path, with no root and no fence
 * (`~/.ssh` answers like any other), so only a manifest that declares `permissions.checkDirectory` gets it; any
 * other plugin's call is refused naming the plugin (the way `hostFacts` is).
 */
export function gatedPaths(plugin: string, declared: boolean, base: PathsPort): PathsPort {
  if (declared) return base;
  return Object.freeze({
    home: base.home,
    checkDirectory: async () => {
      throw new Error(`${plugin} did not declare permissions.checkDirectory, so it probes no absolute path.`);
    },
    // Gated on their own permission ({@link gatedWhich}), never by this one.
    which: base.which,
    locate: base.locate,
    whichFor: base.whichFor,
  });
}

/**
 * `kernel.paths.which`, `locate` and `whichFor` for one plugin: the lookups themselves (`./which.ts`) only for a
 * manifest that declares `permissions.which`; any other plugin's call is refused naming the plugin, as
 * `checkDirectory` is. They tell what is installed where, which a plugin that never asked has no business learning.
 */
export function gatedWhich(plugin: string, declared: boolean, base: PathsPort): PathsPort {
  if (declared) return base;
  const refused = async (): Promise<never> => {
    throw new Error(`${plugin} did not declare permissions.which, so it looks no command up.`);
  };
  return Object.freeze({
    home: base.home,
    checkDirectory: base.checkDirectory,
    which: refused,
    locate: refused,
    whichFor: refused,
  });
}

/**
 * `kernel.paths.locate`'s variable gate: only a variable this plugin declared in `permissions.whichOverrides`, by
 * exact name ({@link mayReadOverride}); any other is refused naming the plugin BEFORE anything is read.
 */
export function gatedOverrides(plugin: string, declared: readonly string[] | undefined, base: PathsPort): PathsPort {
  return Object.freeze({
    ...base,
    locate: async (name: string, options: Parameters<PathsPort['locate']>[1]) => {
      const variable: unknown = options?.override;
      if (!mayReadOverride(declared, variable))
        throw new Error(
          `${plugin} asked for an override variable its permissions.whichOverrides does not declare, so it reads no override.`,
        );
      return await base.locate(name, { ...options, override: variable });
    },
  });
}
