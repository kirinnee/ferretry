import type { RuntimeSkillAssets } from '../../lib/catalog-installs/ports.ts';
import { applySkillFolder, inspectSkillFolder, readSkillFiles } from './skill-folder.ts';

/** `<fleet>/assets/skills/<name>`. The fleet service writes the files; this only reads them and prunes the ones an old install left. */
export class FileRuntimeSkillAssets implements RuntimeSkillAssets {
  constructor(private readonly skillsDirectory: string) {}

  async inspect(name: string) {
    return await inspectSkillFolder(this.skillsDirectory, name);
  }

  async read(name: string, paths: readonly string[]) {
    return await readSkillFiles(this.skillsDirectory, name, paths);
  }

  async remove(name: string, expected: ReadonlyMap<string, string | null>): Promise<void> {
    await applySkillFolder(this.skillsDirectory, name, { write: [], remove: [...expected.keys()], expected });
  }
}
