import type { ChosenDaemon } from '@ferretry/app';
import type { ChooseInstall } from '../features/shared/shared-item-sheet.tsx';
import { catalogClientOf } from './catalog-client.ts';
import { daemonConnection } from './machine.ts';
import { readRegisteredProjects } from './registered-projects.ts';

/** The question Install asks on `/shared`, which has no machine of its own. */
export const INSTALL_ON_WHICH = 'Install on which machine?';

/**
 * Install on a screen with no machine of its own (S10): ask the shell, and build the install host from the ONE machine
 * the person picked. Everything the install reads or sends rides that machine's Catalogs client, and the project list
 * is that machine's own, read through the same client. A cancel answers `undefined`; nothing is installed.
 */
export const installChooser =
  (chooseDaemon: (purpose: string) => Promise<ChosenDaemon | undefined>): ChooseInstall =>
  async () => {
    const chosen = await chooseDaemon(INSTALL_ON_WHICH);
    if (chosen === undefined) return undefined;
    const own = catalogClientOf(chosen.client);
    return {
      machine: {
        connection: daemonConnection({ daemonId: chosen.daemon, daemonName: chosen.machine }),
        name: chosen.machine,
      },
      host: {
        createClient: async () => own,
        readProjects: () => readRegisteredProjects(chosen.client),
      },
    };
  };
