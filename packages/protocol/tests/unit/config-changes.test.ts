import { describe, it } from 'bun:test';
import should from 'should';
import * as changes from '../../src/lib/config-changes.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const cases: readonly SchemaCase[] = [
  { name: 'ConfigChangeKindSchema', schema: changes.ConfigChangeKindSchema, value: 'runtimes' },
  { name: 'ConfigRevisionSchema', schema: changes.ConfigRevisionSchema, value: { epoch: 'boot', revision: 0 } },
  {
    name: 'ConfigChangeFrameSchema first frame',
    schema: changes.ConfigChangeFrameSchema,
    value: { kind: 'config', epoch: 'boot', revision: 3, kinds: [] },
  },
  {
    name: 'ConfigChangeFrameSchema change',
    schema: changes.ConfigChangeFrameSchema,
    value: { kind: 'config', epoch: 'boot', revision: 4, kinds: ['credentials', 'runtimes'] },
  },
  {
    name: 'ConfigChangeFrameSchema idle',
    schema: changes.ConfigChangeFrameSchema,
    value: { kind: 'idle', epoch: 'boot', revision: 4, idleSeconds: 30 },
  },
];

describe('the configuration change wire contract', () => {
  it('should round-trip every shape and cover every exported schema', () => {
    // Act & Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(changes, cases);
  });

  it('should refuse a frame naming a kind no screen shows, an extra field, or no epoch', () => {
    // Act & Assert
    assertRejects([
      {
        name: 'unknown kind',
        schema: changes.ConfigChangeFrameSchema,
        value: { kind: 'config', epoch: 'boot', revision: 1, kinds: ['everything'] },
      },
      {
        name: 'extra field',
        schema: changes.ConfigChangeFrameSchema,
        value: { kind: 'config', epoch: 'boot', revision: 1, kinds: [], text: 'a secret could ride here' },
      },
      {
        name: 'no epoch',
        schema: changes.ConfigChangeFrameSchema,
        value: { kind: 'idle', revision: 1, idleSeconds: 30 },
      },
      { name: 'negative revision', schema: changes.ConfigRevisionSchema, value: { epoch: 'boot', revision: -1 } },
    ]);
  });

  it('should pin the topic the stream is asked for with', () => {
    should(changes.CONFIG_CHANGE_TOPIC).equal('config');
  });
});

describe('configChangeKindsForPaths', () => {
  it('should name what each kind of file feeds, always with the file list', () => {
    // Act & Assert — a login is part of every runtime on it; a component of every profile and runtime.
    should(changes.configChangeKindsForPaths(['logins/work.yaml'])).deepEqual(['files', 'credentials', 'runtimes']);
    should(changes.configChangeKindsForPaths(['components/mcp/github.yaml'])).deepEqual([
      'files',
      'components',
      'profiles',
      'runtimes',
    ]);
    should(changes.configChangeKindsForPaths(['profiles/default.yaml'])).deepEqual(['files', 'profiles', 'runtimes']);
    should(changes.configChangeKindsForPaths(['runtimes/main.yaml'])).deepEqual(['files', 'runtimes']);
    should(changes.configChangeKindsForPaths(['machine.yaml'])).deepEqual(['files', 'machine', 'runtimes']);
    should(changes.configChangeKindsForPaths(['warden.yaml', 'voice.yaml', 'learning.yaml'])).deepEqual([
      'files',
      'warden',
      'learning',
      'voice',
    ]);
    should(changes.configChangeKindsForPaths(['presets/gateway.yaml'])).deepEqual(['files', 'credentials', 'presets']);
  });

  it('should still say the file list moved for a path that is not a configuration file', () => {
    // Act & Assert — a stray `notes.yml` is reported in the file list, so the list is read again.
    should(changes.configChangeKindsForPaths(['notes.yml'])).deepEqual(['files']);
  });
});
