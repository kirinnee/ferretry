import type { FerretId } from '@ferretry/kernel/contract';
import type { CodexCredentialLinks } from '../../lib/index.ts';
import type { HarnessPart } from './context.ts';

/** Taking a login's sign-in back out of the ferret homes it was linked into. */
export const credentialsPart: HarnessPart<'credentials'> = ({ kernel, linked, homeRoot, say }) => {
  /**
   * Takes the login's sign-in out of one ferret's home: the link this plugin made, and a file Codex may have written in
   * its place (a copy of the same sign-in). A FOLDER at the name is left alone. Total: a ferret that never had a link, a
   * home that was never made, and a removal that fails all end here (the failure said once, by ferret id, never a path
   * or a token). The next `prepareHome` clears the name again, so a failure here never outlives the next launch.
   */
  const clearCredential = async (ferret: string): Promise<void> => {
    linked.delete(ferret);
    try {
      const root = homeRoot(ferret as FerretId);
      // A ferret of another harness, or one that never started, has no home here: nothing to clear, nothing to say.
      const homes = kernel.roots.root('agent-homes');
      const folder = homes.resolve(ferret);
      if (!folder.ok || (await homes.lstat(folder.value))?.kind !== 'directory') return;
      const at = root.resolve('auth.json');
      if (!at.ok) return;
      const found = await root.lstat(at.value);
      if (found?.kind === 'symlink') await root.unlink(at.value);
      else if (found?.kind === 'file') await root.remove(at.value);
    } catch {
      say(`Ferret ${ferret}: the login's sign-in could not be taken out of its Codex home; the next launch clears it.`);
    }
  };

  const credentials: CodexCredentialLinks = {
    released: clearCredential,
    revoked: async login => {
      const ferrets = [...linked].filter(([, held]) => held === login).map(([ferret]) => ferret);
      await Promise.all(ferrets.map(clearCredential));
    },
  };

  return {
    credentials,
  };
};
