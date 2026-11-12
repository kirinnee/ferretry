/**
 * The one decision about the published manifest's text: nothing, a manifest, or something that is not one. The manifest is
 * derived from the configuration, so the third answer means "write it again", never "refuse".
 */
import { describe, expect, it } from 'bun:test';
import { buildFleetManifest } from '../../../daemon/lib/manifest.ts';
import {
  keptManifestName,
  manifestRebuiltSentence,
  manifestUnreadableSentence,
  readManifestText,
} from '../../../daemon/lib/manifest-reading.ts';

const manifest = buildFleetManifest({
  generatedAt: '2027-01-15T08:00:00.000Z',
  accounts: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      kind: 'claude',
      mode: 'interactive',
      wrapper: '/fleet/bin/claude-work',
      home: '/fleet/homes/one',
      displayName: 'claude-work',
      defaultModel: 'm',
      models: [{ id: 'm', available: true }],
      available: true,
      unavailableReason: null,
    },
  ],
  runtimes: [],
});

describe('readManifestText', () => {
  it('reads no file as absent', () => {
    expect(readManifestText(undefined)).toEqual({ kind: 'absent' });
  });

  it('reads a manifest this version writes as readable', () => {
    const reading = readManifestText(JSON.stringify(manifest));
    expect(reading.kind).toBe('readable');
    expect(reading.kind === 'readable' && reading.manifest.accounts).toHaveLength(1);
  });

  it('reads a truncated or non-JSON file as unreadable', () => {
    expect(readManifestText(JSON.stringify(manifest).slice(0, 40))).toEqual({ kind: 'unreadable' });
    expect(readManifestText('')).toEqual({ kind: 'unreadable' });
  });

  it('reads any unknown key on an account row as unreadable without naming the key (generic, not key-specific)', () => {
    const [account] = manifest.accounts;
    const shaped = { ...manifest, accounts: [{ ...account, anyKeyAnyVersionWrote: { a: 1 } }] };
    expect(readManifestText(JSON.stringify(shaped))).toEqual({ kind: 'unreadable' });
  });

  it('reads valid JSON of another shape as unreadable', () => {
    expect(readManifestText('[]')).toEqual({ kind: 'unreadable' });
    expect(readManifestText('{"version":2}')).toEqual({ kind: 'unreadable' });
  });
});

describe('the words about an unreadable manifest', () => {
  it('names the file kept aside by a short digest, so the same damage is kept once', () => {
    expect(keptManifestName('/fleet/manifest.json', 'abcdef0123456789ffff')).toBe(
      '/fleet/manifest.json.unreadable-abcdef012345',
    );
  });

  it('says in one line that it is being rebuilt and where the old file is, or that it could not be kept', () => {
    const kept = manifestRebuiltSentence('/fleet/manifest.json', '/fleet/manifest.json.unreadable-abc');
    expect(kept).toContain('/fleet/manifest.json could not be read');
    expect(kept).toContain('rebuilt from the configuration');
    expect(kept).toContain('/fleet/manifest.json.unreadable-abc (owner-only)');
    expect(manifestRebuiltSentence('/fleet/manifest.json', undefined)).toContain('could not be kept aside');
    expect(kept).not.toContain('\n');
  });

  it('tells a reader the refusal is retryable', () => {
    const sentence = manifestUnreadableSentence('/fleet/manifest.json');
    expect(sentence).toContain('/fleet/manifest.json');
    expect(sentence).toContain('try again');
  });
});
