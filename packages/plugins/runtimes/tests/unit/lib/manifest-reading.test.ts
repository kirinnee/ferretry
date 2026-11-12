/**
 * The one decision about the published manifest's text: nothing, a manifest, or something that is not one. The manifest is
 * derived from the configuration, so the third answer means "write it again", never "refuse".
 */
import { describe, expect, it } from 'bun:test';
import { buildFleetManifest } from '../../../daemon/lib/manifest.ts';
import {
  FleetManifestUnreadableError,
  KEPT_MANIFEST_INFIX,
  keptManifestName,
  MAX_KEPT_UNREADABLE_MANIFESTS,
  manifestRebuiltSentence,
  manifestUnreadableSentence,
  readManifestText,
  surplusKeptCopies,
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

describe('surplusKeptCopies', () => {
  const prefix = `manifest.json${KEPT_MANIFEST_INFIX}`;
  const copy = (digest: string, modified: string) => ({ name: `${prefix}${digest}`, modified });

  it('keeps a small fixed number of the most recent copies and names the older ones for removal', () => {
    expect(MAX_KEPT_UNREADABLE_MANIFESTS).toBe(3);
    const copies = [
      copy('a', '2027-01-01T00:00:01.000Z'),
      copy('b', '2027-01-01T00:00:02.000Z'),
      copy('c', '2027-01-01T00:00:03.000Z'),
      copy('d', '2027-01-01T00:00:04.000Z'),
      copy('e', '2027-01-01T00:00:05.000Z'),
    ];
    expect(surplusKeptCopies(copies, prefix, `${prefix}c`)).toEqual([`${prefix}b`, `${prefix}a`]);
  });

  it('never names the protected copy, even when it is the oldest', () => {
    const copies = [
      copy('a', '2027-01-01T00:00:01.000Z'),
      copy('b', '2027-01-01T00:00:02.000Z'),
      copy('c', '2027-01-01T00:00:03.000Z'),
      copy('d', '2027-01-01T00:00:04.000Z'),
    ];
    expect(surplusKeptCopies(copies, prefix, `${prefix}a`)).toEqual([`${prefix}b`]);
  });

  it('breaks a tie of age by name, so the choice is the same every time', () => {
    const same = '2027-01-01T00:00:01.000Z';
    const copies = ['d', 'a', 'c', 'b'].map(digest => copy(digest, same));
    expect(surplusKeptCopies(copies, prefix, undefined, 2)).toEqual([`${prefix}c`, `${prefix}d`]);
  });

  it('chooses nothing that does not begin with the prefix, and nothing when there are few copies', () => {
    const others = [
      { name: 'manifest.json', modified: '2027-01-01T00:00:01.000Z' },
      { name: 'other.json.unreadable-a', modified: '2027-01-01T00:00:01.000Z' },
    ];
    expect(surplusKeptCopies(others, prefix, undefined, 0)).toEqual([]);
    expect(surplusKeptCopies([copy('a', '2027-01-01T00:00:01.000Z')], prefix, `${prefix}a`)).toEqual([]);
    expect(surplusKeptCopies([], prefix, undefined)).toEqual([]);
  });
});

describe('FleetManifestUnreadableError', () => {
  it('carries the path and the retryable sentence', () => {
    const error = new FleetManifestUnreadableError('/fleet/manifest.json');
    expect(error.path).toBe('/fleet/manifest.json');
    expect(error.name).toBe('FleetManifestUnreadableError');
    expect(error.message).toBe(manifestUnreadableSentence('/fleet/manifest.json'));
  });
});
