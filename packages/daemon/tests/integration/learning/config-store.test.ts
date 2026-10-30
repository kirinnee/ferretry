/**
 * Learning's writes into the configuration files, against the REAL configuration service over an
 * in-memory directory, so a write is evaluated and an owner's comment really survives the edit.
 */
import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import type { AcceptedConfigFiles, ConfigFileText } from '@ferretry/fleet';
import should from 'should';
import { ConfigFileLearningSettings } from '../../../src/adapters/learning/config-store.ts';
import {
  type AcceptedConfigStore,
  type ConfigDirectoryPort,
  ConfigFilesService,
} from '../../../src/lib/config-files/index.ts';

const LEARNING = 'learning.yaml';
const LESSONS_COMPONENT = 'components/instructions/lessons.yaml';

class MemoryDirectory implements ConfigDirectoryPort {
  readonly directory = '/home/operator/.fy/config';
  readonly texts = new Map<string, string>();
  readonly writes: string[] = [];

  async list(): Promise<{ readonly files: readonly ConfigFileText[]; readonly unreadable: readonly string[] }> {
    return { files: [...this.texts].map(([path, text]) => ({ path, text })), unreadable: [] };
  }

  async fingerprint(): Promise<string> {
    return [...this.texts.keys()].join('\n');
  }

  async read(path: string): Promise<string | undefined> {
    return this.texts.get(path);
  }

  async write(path: string, text: string): Promise<void> {
    this.writes.push(path);
    this.texts.set(path, text);
  }

  async remove(path: string): Promise<void> {
    this.texts.delete(path);
  }

  async writeSchemas(): Promise<void> {}
}

class MemoryAccepted implements AcceptedConfigStore {
  accepted: AcceptedConfigFiles = {};

  async read(): Promise<AcceptedConfigFiles> {
    return this.accepted;
  }

  async write(accepted: AcceptedConfigFiles): Promise<void> {
    this.accepted = accepted;
  }
}

function world(files: Readonly<Record<string, string>> = {}): {
  readonly directory: MemoryDirectory;
  readonly settings: ConfigFileLearningSettings;
} {
  const directory = new MemoryDirectory();
  for (const [path, text] of Object.entries(files)) directory.texts.set(path, text);
  const service = new ConfigFilesService({
    directory,
    accepted: new MemoryAccepted(),
    log: { issue: () => undefined, pending: () => undefined },
    digest: text => createHash('sha256').update(text, 'utf8').digest('hex'),
    now: () => new Date('2026-10-16T09:00:00.000Z'),
  });
  return { directory, settings: new ConfigFileLearningSettings(service) };
}

describe('ConfigFileLearningSettings', () => {
  it('should write a changed passive default key by key, keep the owner comment, and answer the new settings', async () => {
    // Arrange
    const { directory, settings } = world({ [LEARNING]: '# the owner wrote this\npassiveDefault: false\n' });

    // Act
    const learning = await settings.writePassiveDefault(true);

    // Assert
    should(learning.passiveDefault).be.true();
    should(directory.writes).deepEqual([LEARNING]);
    should(directory.texts.get(LEARNING)).containEql('# the owner wrote this');
    should(directory.texts.get(LEARNING)).match(/passiveDefault: true/);
  });

  it('should not write an unchanged passive default and answer the settings in effect', async () => {
    // Arrange
    const { directory, settings } = world({ [LEARNING]: '# the owner wrote this\npassiveDefault: false\n' });

    // Act
    const learning = await settings.writePassiveDefault(false);

    // Assert
    should(learning.passiveDefault).be.false();
    should(directory.writes).deepEqual([]);
  });

  it('should answer the account model in effect', async () => {
    // Arrange
    const { settings } = world({ 'components/instructions/main.yaml': 'file: main.md\n' });

    // Act
    const model = await settings.model();

    // Assert
    should(model.components.instructions.main?.file).equal('main.md');
  });

  it('should write the lessons component once and leave an identical one alone', async () => {
    // Arrange
    const { directory, settings } = world();

    // Act
    await settings.writeLessonsComponent('instructions/lessons.md');
    await settings.writeLessonsComponent('instructions/lessons.md');
    const model = await settings.model();

    // Assert
    should(directory.writes).deepEqual([LESSONS_COMPONENT]);
    should(directory.texts.get(LESSONS_COMPONENT)).match(/file: instructions\/lessons\.md/);
    should(model.components.instructions.lessons?.file).equal('instructions/lessons.md');
  });
});
