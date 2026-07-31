import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { FileFleetConfigSource, FleetConfigFileError } from '../../src/adapters/config-file.ts';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'fy-fleet-config-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('FileFleetConfigSource', () => {
  it('should parse YAML through the strict fleet schema', async () => {
    // Arrange
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, 'config.yaml');
    await Bun.write(
      configPath,
      [
        'secretsFile: ./placeholder-secrets',
        'variants:',
        '  auto:',
        '    mode: auto',
        'agents:',
        '  - name: account-with-hyphens',
        '    kind: claude',
        '    routes:',
        '      auto:',
        '        id: 00000000-0000-4000-8000-000000000001',
        '        mode: auto',
        '        wrapper: alias-with-hyphens',
        '        home: /tmp/fy-test/homes/one',
        '        displayName: Placeholder Account',
        '        defaultModel: model-one',
        '        models:',
        '          - id: model-one',
        '            displayName: Model One',
        '            available: true',
      ].join('\n'),
    );
    const subject = new FileFleetConfigSource(configPath);

    // Act
    const actual = await subject.load();

    // Assert
    should(actual.agents).have.length(1);
    should(actual.agents[0]?.name).equal('account-with-hyphens');
    should(actual.secretsFile).equal('./placeholder-secrets');
  });

  it('should report schema failures with the source path', async () => {
    // Arrange
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, 'config.yaml');
    await Bun.write(configPath, 'unexpectedKey: true\n');
    const subject = new FileFleetConfigSource(configPath);

    // Act
    const promise = subject.load();

    // Assert
    await should(promise).be.rejectedWith(FleetConfigFileError);
    await promise.catch(error => should(String(error)).containEql(configPath));
  });

  it('should reject a missing file without falling back to a user home', async () => {
    // Arrange
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, 'missing.yaml');
    const subject = new FileFleetConfigSource(configPath);

    // Act
    const promise = subject.load();

    // Assert
    await should(promise).be.rejectedWith(FleetConfigFileError);
  });
});
