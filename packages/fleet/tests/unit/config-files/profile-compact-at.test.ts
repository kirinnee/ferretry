import { describe, it } from 'bun:test';
import should from 'should';
import { checkConfigFile } from '../../../src/lib/config-files/check.ts';
import { evaluateConfigFiles } from '../../../src/lib/config-files/evaluate.ts';
import { configJsonSchema } from '../../../src/lib/config-files/json-schema.ts';
import { configFileBody, configValue, ProfileFileSchema } from '../../../src/lib/config-files/kinds.ts';
import { digest, FLEET_FILES, file } from './support.ts';

const PROFILE = (extra: string) => `contents:\n  - instructions/main\n${extra}`;

describe('a profile file with compactAt', () => {
  it.each([
    ['a token count', 'compactAt: 250000\n', 250_000],
    ['the floor', 'compactAt: 100000\n', 100_000],
    ['auto', 'compactAt: auto\n', 'auto'],
  ] as const)('should parse %s', (_label, text, expected) => {
    // Act
    const actual = checkConfigFile('profiles/lead.yaml', PROFILE(text));

    // Assert
    should(actual.ok).be.true();
    should(ProfileFileSchema.parse({ contents: [], compactAt: expected }).compactAt).equal(expected);
    if (actual.ok) should((actual.value as { compactAt?: unknown }).compactAt).equal(expected);
  });

  it.each([
    ['50000', 'compactAt: 50000\n'],
    ['a word', 'compactAt: big\n'],
    ['a fraction', 'compactAt: 250000.5\n'],
  ])('should refuse %s, as a runtime does', (_label, text) => {
    // Act
    const profile = checkConfigFile('profiles/lead.yaml', PROFILE(text));
    const runtime = checkConfigFile('runtimes/lead.yaml', `credential: you\nprofile: lead\n${text}`);

    // Assert
    should(profile.ok).be.false();
    should(profile.issues[0]?.message).equal(runtime.issues[0]?.message);
    should(profile.issues[0]?.message).not.containEql('Unrecognized key');
  });

  it('should still refuse a key it does not know', () => {
    should(checkConfigFile('profiles/lead.yaml', PROFILE('compactAtt: auto\n')).ok).be.false();
  });

  it('should carry compactAt through the file value and back to the file body', () => {
    // Arrange
    const value = configValue('profile', ProfileFileSchema.parse({ contents: ['mcp/x'], compactAt: 300_000 }));

    // Act
    const body = configFileBody('profile', value);

    // Assert
    should(value).deepEqual({ layers: ['mcp/x'], compactAt: 300_000 });
    should(body).deepEqual({ contents: ['mcp/x'], compactAt: 300_000 });
  });

  it('should leave compactAt out of the value and body when the file has none', () => {
    // Arrange
    const value = configValue('profile', ProfileFileSchema.parse({ contents: ['mcp/x'] }));

    // Act + Assert
    should(value).deepEqual({ layers: ['mcp/x'] });
    should(configFileBody('profile', value)).deepEqual({ contents: ['mcp/x'] });
  });

  it('should publish compactAt in the profile JSON schema', () => {
    // Act
    const schema = configJsonSchema('profile') as { properties: Record<string, unknown> };

    // Assert
    should(Object.keys(schema.properties)).containEql('compactAt');
  });

  it('should reach the account model through the directory evaluation', () => {
    // Arrange
    const files = FLEET_FILES.map(entry =>
      entry.path === 'profiles/default.yaml' ? file(entry.path, PROFILE('compactAt: 250000\n')) : entry,
    );

    // Act
    const actual = evaluateConfigFiles({ files, accepted: {}, digest });

    // Assert
    should(actual.issues).deepEqual([]);
    should(actual.effective.model.profiles.default?.compactAt).equal(250_000);
  });
});
