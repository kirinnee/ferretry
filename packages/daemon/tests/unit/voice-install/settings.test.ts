import { describe, it } from 'bun:test';
import { configFilePath, VoiceConfigSchema } from '@ferretry/protocol';
import should from 'should';
import { ConfigFileVoiceEngineSettings } from '../../../src/adapters/voice-install/index.ts';

const PATH = configFilePath({ kind: 'voice' });

interface World {
  readonly disk: string | undefined;
  readonly pendingText?: string;
  readonly effective?: unknown;
  readonly accepted?: string;
}

/** The slice of the configuration service the settings read, with the files and evaluation the test hands it. */
function service(world: World) {
  const writes: { path: string; text: string; inEffect: string | undefined }[] = [];
  const snapshot = {
    files: new Map(world.disk === undefined ? [] : [[PATH, { text: world.disk, etag: 'e1' }]]),
    evaluation: {
      effective: { voice: VoiceConfigSchema.parse(world.effective ?? {}) },
      pending: world.pendingText === undefined ? [] : [{ path: PATH }],
      accepted: world.accepted === undefined ? {} : { [PATH]: { text: world.accepted } },
    },
  };
  const fake = {
    inEffect: async () => snapshot,
    load: async () => snapshot,
    writeOwn: async (path: string, text: string, inEffect?: string) => {
      writes.push({ path, text, inEffect });
    },
  };
  return { settings: new ConfigFileVoiceEngineSettings(fake as never), writes };
}

describe('the speech engine settings in voice.yaml', () => {
  it('should read the engine block in effect, empty when the file names none', async () => {
    // Arrange
    const empty = service({ disk: undefined });
    const chosen = service({
      disk: undefined,
      effective: { engine: { batch: 'whisper-turbo', runtimePath: '/opt/sherpa' } },
    });

    // Act + Assert
    should(await empty.settings.read()).deepEqual({});
    should(await chosen.settings.read()).deepEqual({ batch: 'whisper-turbo', runtimePath: '/opt/sherpa' });
  });

  it('should add the chosen model to a file that has none, keeping the owner’s comment', async () => {
    // Arrange
    const disk = '# who cleans up my dictation\npostProcessing:\n  provider: groq\n';
    const { settings, writes } = service({ disk, effective: { postProcessing: { provider: 'groq' } } });

    // Act
    await settings.setModel('batch', 'whisper-turbo');

    // Assert
    should(writes.length).equal(1);
    should(writes[0]?.path).equal(PATH);
    should(writes[0]?.text).match(/# who cleans up my dictation/u);
    should(writes[0]?.text).match(/engine:\n {2}batch: whisper-turbo/u);
    should(writes[0]?.text).match(/provider: groq/u);
    should(writes[0]?.inEffect).be.undefined();
  });

  it('should write a file when there is none', async () => {
    // Arrange
    const { settings, writes } = service({ disk: undefined });

    // Act
    await settings.setModel('streaming', 'nemotron-streaming-0.6b-560ms-int8');

    // Assert
    should(writes[0]?.text).match(/streaming: nemotron-streaming-0.6b-560ms-int8/u);
  });

  it('should change only the role asked for', async () => {
    // Arrange
    const disk = 'engine:\n  batch: whisper-turbo\n  streaming: old\n';
    const { settings, writes } = service({ disk, effective: { engine: { batch: 'whisper-turbo', streaming: 'old' } } });

    // Act
    await settings.setModel('streaming', 'new');

    // Assert
    should(writes[0]?.text).match(/batch: whisper-turbo/u);
    should(writes[0]?.text).match(/streaming: new/u);
    should(writes[0]?.text).not.match(/old/u);
  });

  it('should clear a role with null, so the recommended model applies again', async () => {
    // Arrange
    const disk = 'engine:\n  batch: whisper-turbo\n  runtimePath: /opt/sherpa\n';
    const { settings, writes } = service({
      disk,
      effective: { engine: { batch: 'whisper-turbo', runtimePath: '/opt/sherpa' } },
    });

    // Act
    await settings.setModel('batch', null);

    // Assert
    should(writes[0]?.text).not.match(/whisper-turbo/u);
    should(writes[0]?.text).match(/runtimePath: \/opt\/sherpa/u);
  });

  it('should write nothing when the choice is already what the file says', async () => {
    // Arrange
    const disk = 'engine:\n  batch: whisper-turbo\n';
    const { settings, writes } = service({ disk, effective: { engine: { batch: 'whisper-turbo' } } });

    // Act
    await settings.setModel('batch', 'whisper-turbo');

    // Assert
    should(writes).deepEqual([]);
  });

  it('should make the choice to BOTH versions while an edit waits for the owner, never discarding the held edit', async () => {
    // Arrange — the file on disk holds a held loosening (a runtime path); what is in effect has none.
    const held = 'engine:\n  runtimePath: /opt/held\n';
    const { settings, writes } = service({
      disk: held,
      pendingText: held,
      effective: {},
      accepted: '# in effect\n',
    });

    // Act
    await settings.setModel('batch', 'whisper-turbo');

    // Assert
    should(writes.length).equal(1);
    should(writes[0]?.text).match(/runtimePath: \/opt\/held/u);
    should(writes[0]?.text).match(/batch: whisper-turbo/u);
    should(writes[0]?.inEffect).match(/batch: whisper-turbo/u);
    should(writes[0]?.inEffect).not.match(/held/u);
  });
});
