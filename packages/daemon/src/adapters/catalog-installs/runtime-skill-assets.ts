import type { RuntimeSkillAssets } from '../../lib/catalog-installs/ports.ts';
import { applySkillFolder, inspectSkillFolder } from './skill-folder.ts';

/** `<fleet>/assets/skills/<name>`. The fleet service writes the files; this only reads them and prunes the ones an old install left. */
export class FileRuntimeSkillAssets implements RuntimeSkillAssets {
  constructor(private readonly skillsDirectory: string) {}

  async inspect(name: string) {
    return await inspectSkillFolder(this.skillsDirectory, name);
  }

  async remove(name: string, paths: readonly string[]): Promise<void> {
    const reading = await inspectSkillFolder(this.skillsDirectory, name);
    if (!reading.exists) return;
    const expected = new Map<string, string | null>(paths.map(path => [path, reading.files.get(path) ?? null]));
    await applySkillFolder(this.skillsDirectory, name, { write: [], remove: paths, expected });
  }
}
