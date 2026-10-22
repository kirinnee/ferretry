import { type AccountModel, renderConfigFile } from '@ferretry/fleet';
import { type ConfigFileAddress, configFilePath, type LearningConfig } from '@ferretry/protocol';
import type { ConfigFilesService } from '../../lib/config-files/index.ts';
import { GLOBAL_LESSONS_COMPONENT } from '../../lib/learning/index.ts';

const LEARNING_FILE: ConfigFileAddress = { kind: 'learning' };
const LESSONS_COMPONENT_FILE: ConfigFileAddress = {
  kind: 'component',
  componentKind: 'instructions',
  name: GLOBAL_LESSONS_COMPONENT,
};

/**
 * Learning's two writes into the configuration files (docs/config-files.md), each the owner's own act
 * and so acknowledged rather than held: Settings › Learning's machine default in `learning.yaml`, and
 * the `instructions/lessons` component the first Global Apply creates. Both are edited key by key, so
 * the owner's comments survive.
 */
export class ConfigFileLearningSettings {
  constructor(private readonly config: Pick<ConfigFilesService, 'inEffect' | 'load' | 'writeOwn'>) {}

  /** The learning settings in effect, after writing `passiveDefault` when it changes. */
  async writePassiveDefault(passiveDefault: boolean): Promise<LearningConfig> {
    const path = configFilePath(LEARNING_FILE);
    const { files, evaluation } = await this.config.load();
    const next = { ...evaluation.effective.learning, passiveDefault };
    const text = renderConfigFile(path, LEARNING_FILE, next, files.get(path)?.text);
    if (text === undefined) return evaluation.effective.learning;
    await this.config.writeOwn(path, text);
    return (await this.config.load()).evaluation.effective.learning;
  }

  /** The account model in effect. */
  async model(): Promise<AccountModel> {
    return (await this.config.inEffect()).evaluation.effective.model;
  }

  /** Writes `components/instructions/lessons.yaml` pointing at `file`. */
  async writeLessonsComponent(file: string): Promise<void> {
    const path = configFilePath(LESSONS_COMPONENT_FILE);
    const { files } = await this.config.load();
    const text = renderConfigFile(path, LESSONS_COMPONENT_FILE, { file }, files.get(path)?.text);
    if (text !== undefined) await this.config.writeOwn(path, text);
  }
}
