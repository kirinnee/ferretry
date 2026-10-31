import type { ProjectSkillFiles, SkillFolderChange } from '../../lib/catalog-installs/ports.ts';
import { applySkillFolder, inspectSkillFolder } from './skill-folder.ts';

/** `<root>/.claude/skills/<name>` or `<root>/.agents/skills/<name>`; every rule is in `skill-folder.ts`. */
export class FileProjectSkillFiles implements ProjectSkillFiles {
  constructor(private readonly uniqueId?: () => string) {}

  async inspect(root: string, folder: string) {
    return await inspectSkillFolder(root, folder);
  }

  async apply(root: string, folder: string, change: SkillFolderChange): Promise<void> {
    await applySkillFolder(root, folder, change, this.uniqueId);
  }
}
