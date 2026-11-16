import { describe, it } from 'bun:test';
import should from 'should';
import {
  BuiltInPresetError,
  builtInPresets,
  parsePresetText,
  presetCatalog,
} from '../../../daemon/lib/presets/catalog.ts';
import { type ProviderPreset, ProviderPresetFileSchema, presetHarnesses } from '../../../daemon/lib/presets/schema.ts';
import { findRawSecrets } from '../../../contract/secret-shape.ts';

const PRESETS = builtInPresets();
const preset = (id: string): ProviderPreset => PRESETS.find(entry => entry.id === id) as ProviderPreset;

describe('the built-in preset catalogue', () => {
  it('should list Claude Code presets before Codex-only ones', () => {
    should(PRESETS.findIndex(entry => entry.harness === 'codex')).equal(
      PRESETS.filter(entry => entry.harness === 'claude').length,
    );
  });

  it.each(builtInPresets().map(entry => entry.id))('should ship %s as a file the catalogue lists as a built-in', id => {
    should(preset(id).id).equal(id);
    should(preset(id).origin).equal('built-in');
  });

  it('should hold no raw secret in any shipped preset file', () => {
    for (const entry of PRESETS) {
      for (const half of Object.values(entry.halves)) {
        should(findRawSecrets(half?.env ?? {})).deepEqual([]);
      }
    }
  });

  it('should hide a preset whose Codex half cannot run, with the reason, while Claude Code stays usable', () => {
    const glm = preset('zai-glm');
    should(glm.unavailable).be.undefined();
    should(glm.halves.codex?.unavailable).be.a.String();
    should(presetHarnesses(glm)).deepEqual(['claude']);
  });

  it('should keep every secret a NAME and every test key a secret', () => {
    for (const entry of PRESETS) {
      for (const variable of Object.values(entry.env)) {
        if (variable.secretName !== undefined) should(variable.value).be.undefined();
      }
      if (entry.test.kind === 'request' || entry.test.kind === 'inference') {
        should(entry.env[entry.test.keyVariable]?.secretName).be.a.String();
      }
    }
  });

  it('should file the presets under the grid headings, leaving the ones nobody asked to group under none', () => {
    const grouped = (group: string | undefined) =>
      PRESETS.filter(entry => entry.group === group).map(entry => entry.id);
    should(grouped('popular')).containEql('zai-glm');
    should(grouped('cloud')).containEql('amazon-bedrock');
    should(grouped('self-hosted')).containEql('custom-gateway');
    should(ProviderPresetFileSchema.safeParse({ group: 'favourite' }).error?.issues.map(i => i.path[0])).containEql(
      'group',
    );
  });

  it('should carry the real custom gateway shape: ANTHROPIC_API_KEY a PLAIN variable that is deliberately empty', () => {
    const variable = preset('custom-gateway').env.ANTHROPIC_API_KEY;
    should(variable?.secretName).be.undefined();
    should(variable?.allowEmpty).be.true();
  });
});

describe('parsePresetText', () => {
  it('should name every syntax error', () => {
    const actual = parsePresetText('x', 'label: [unclosed', 'file');
    should(actual.ok).be.false();
    should(!actual.ok && actual.problem).be.a.String();
  });

  it('should name every schema problem by its path', () => {
    const actual = parsePresetText('x', 'label: X\nharness: claude\n', 'file');
    should(!actual.ok && actual.problem).match(/summary: /u);
  });

  it('should name a problem with the file itself as "file"', () => {
    const actual = parsePresetText('x', '- a\n', 'file');
    should(!actual.ok && actual.problem).match(/^file: /u);
  });

  it('should give a preset the id and origin it was read with', () => {
    const text = [
      'label: Mine',
      'summary: A provider.',
      'docs: https://example.test/docs',
      'verified: "2026-10-16"',
      'harness: claude',
      'env: {}',
      'test: { kind: none, reason: no test }',
      'quota: { source: none, note: none }',
    ].join('\n');
    const actual = parsePresetText('mine', text, 'file');
    should(actual.ok && actual.preset.id).equal('mine');
    should(actual.ok && actual.preset.origin).equal('file');
  });
});

describe('BuiltInPresetError', () => {
  it('should say which shipped file is broken', () => {
    const actual = new BuiltInPresetError('kimi', 'docs: invalid');
    should(actual.message).equal('built-in preset kimi does not check: docs: invalid');
    should(actual.name).equal('BuiltInPresetError');
  });
});

describe('presetCatalog', () => {
  it('should lay a machine file over the built-in of its id, in place, and add new ones after, by id', () => {
    const kimi = { ...preset('kimi'), label: 'My Kimi', origin: 'file' as const };
    const zed = { ...preset('kimi'), id: 'zed', origin: 'file' as const };
    const alpha = { ...preset('kimi'), id: 'alpha', origin: 'file' as const };

    const actual = presetCatalog(PRESETS, { zed, kimi, alpha });

    should(actual.find(entry => entry.id === 'kimi')?.label).equal('My Kimi');
    should(actual.findIndex(entry => entry.id === 'kimi')).equal(PRESETS.findIndex(entry => entry.id === 'kimi'));
    should(actual.slice(-2).map(entry => entry.id)).deepEqual(['alpha', 'zed']);
  });
});
