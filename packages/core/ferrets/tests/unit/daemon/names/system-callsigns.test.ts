import { describe, it } from 'bun:test';
import should from 'should';
import { SYSTEM_CALLSIGN_MAX_SEQUENCE } from '../../../../daemon/lib/protocol/system-callsigns.ts';
import { FileSystemCallsignCounters } from '../../../../daemon/adapters/names/index.ts';
import type { FileSystemPort } from '../../../../daemon/lib/ports.ts';
import { issuerOver, MemoryCounters } from './system-callsigns-support.ts';

function memoryFiles(): { readonly files: FileSystemPort; readonly text: Map<string, string> } {
  const text = new Map<string, string>();
  const files = {
    readText: async (path: string) => text.get(path),
    writeTextAtomic: async (path: string, value: string) => {
      text.set(path, value);
    },
  } as unknown as FileSystemPort;
  return { files, text };
}

describe('issuing system callsigns', () => {
  it('should count on from one for each prefix on its own', async () => {
    // Arrange
    const subject = issuerOver();

    // Act
    const names = [await subject.next('learning'), await subject.next('learning'), await subject.next('pack')];

    // Assert
    should(names).deepEqual(['learning-000001', 'learning-000002', 'pack-000001']);
  });

  it('should step past ids the fleet still holds, and only those of its own prefix', async () => {
    // Arrange
    const subject = issuerOver(new MemoryCounters(), () => [
      'learning-000001',
      'learning-000002',
      'pack-000001',
      'ada',
    ]);

    // Act
    const learning = await subject.next('learning');
    const pack = await subject.next('pack');

    // Assert
    should(learning).equal('learning-000003');
    should(pack).equal('pack-000002');
  });

  it('should wrap from ffffff to 000001', async () => {
    // Arrange
    const subject = issuerOver(new MemoryCounters({ pack: SYSTEM_CALLSIGN_MAX_SEQUENCE }));

    // Act + Assert
    should(await subject.next('pack')).equal('pack-000001');
  });

  it('should never give two concurrent starts the same id', async () => {
    // Arrange
    const subject = issuerOver();

    // Act
    const names = await Promise.all([subject.next('learning'), subject.next('learning'), subject.next('learning')]);

    // Assert
    should(new Set(names).size).equal(3);
  });
});

describe('the persisted counters', () => {
  it('should carry on after a restart, through the file', async () => {
    // Arrange
    const { files, text } = memoryFiles();
    const first = issuerOver(new FileSystemCallsignCounters('/state/system-callsigns.json', files));
    await first.next('learning');
    await first.next('learning');
    await first.next('pack');

    // Act
    const second = issuerOver(new FileSystemCallsignCounters('/state/system-callsigns.json', files));

    // Assert
    should(JSON.parse(text.get('/state/system-callsigns.json') ?? '{}')).deepEqual({ learning: 2, pack: 1 });
    should(await second.next('learning')).equal('learning-000003');
    should(await second.next('pack')).equal('pack-000002');
  });

  it('should start again from nothing when the file is damaged or says nonsense', async () => {
    // Arrange
    const { files, text } = memoryFiles();
    const counters = new FileSystemCallsignCounters('/c.json', files);

    // Act + Assert
    should(await counters.read()).deepEqual({});
    text.set('/c.json', '{not json');
    should(await counters.read()).deepEqual({});
    text.set('/c.json', JSON.stringify({ learning: -4, pack: 'x', other: 9 }));
    should(await counters.read()).deepEqual({});
    text.set('/c.json', JSON.stringify({ learning: 7 }));
    should(await counters.read()).deepEqual({ learning: 7 });
  });
});
