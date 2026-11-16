import type { ScratchDirectory, ScratchPort } from '@ferretry/kernel/contract';

/**
 * The folders the Warden's investigators work in: one private scratch folder of the kernel's (outside the Ferretry
 * home, owner-only), and one sub-folder of it per investigator. An investigator is a ferret the Warden started, so it
 * is fenced out of the state home; this folder is its own and holds nothing of the daemon's.
 *
 * The scratch folder is opened on the first investigation, not at boot, and removed by {@link close} when the Warden
 * stops. A folder is named by the investigator's callsign, which is checked: nothing else becomes a path.
 */
export interface WardenWorkFolders {
  /** The absolute, canonical folder for `investigator`, made if it is not there. */
  folderFor(investigator: string): Promise<string>;
  close(): Promise<void>;
}

const PLAIN_NAME = /^[a-z][a-z0-9-]{0,63}$/u;

export class ScratchWardenWorkFolders implements WardenWorkFolders {
  private opening: Promise<ScratchDirectory> | undefined;

  constructor(private readonly scratch: ScratchPort) {}

  async folderFor(investigator: string): Promise<string> {
    if (!PLAIN_NAME.test(investigator)) throw new Error('an investigator folder is named by a plain callsign');
    const root = await this.root();
    await root.makeDirectory(investigator);
    return `${root.path}/${investigator}`;
  }

  async close(): Promise<void> {
    const opening = this.opening;
    this.opening = undefined;
    if (opening !== undefined) await (await opening.catch(() => undefined))?.close();
  }

  private async root(): Promise<ScratchDirectory> {
    this.opening ??= this.scratch.open();
    try {
      return await this.opening;
    } catch (error) {
      this.opening = undefined;
      throw error;
    }
  }
}
