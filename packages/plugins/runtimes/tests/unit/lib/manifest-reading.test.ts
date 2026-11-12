/**
 * The one decision about the published manifest's text: nothing, a manifest, or something that is not one. The manifest is
 * derived from the configuration, so the third answer means "write it again", never "refuse".
 */
import { describe, expect, it } from 'bun:test';
import { buildFleetManifest } from '../../../daemon/lib/manifest.ts';
import {
  FleetManifestUnreadableError,
  KEPT_ASIDE_SUFFIX,
  KeptAsideSchema,
  keptAsideName,
  keptAsideText,
  MAX_KEPT_DAMAGE_BYTES,
  manifestRebuiltSentence,
  manifestUnreadableSentence,
  readKeptAside,
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
  it('names ONE fixed aside file beside the manifest, whatever the damage', () => {
    expect(KEPT_ASIDE_SUFFIX).toBe('.unreadable');
    expect(keptAsideName('/fleet/manifest.json')).toBe('/fleet/manifest.json.unreadable');
  });

  it('says in one line that it is being rebuilt and where the old file is, or that it could not be kept', () => {
    const kept = manifestRebuiltSentence('/fleet/manifest.json', '/fleet/manifest.json.unreadable');
    expect(kept).toContain('/fleet/manifest.json could not be read');
    expect(kept).toContain('rebuilt from the configuration');
    expect(kept).toContain('/fleet/manifest.json.unreadable (owner-only)');
    expect(manifestRebuiltSentence('/fleet/manifest.json', undefined)).toContain('could not be kept aside');
    expect(kept).not.toContain('\n');
  });

  it('tells a reader the refusal is retryable', () => {
    const sentence = manifestUnreadableSentence('/fleet/manifest.json');
    expect(sentence).toContain('/fleet/manifest.json');
    expect(sentence).toContain('try again');
  });
});

describe('the aside envelope', () => {
  const damaged = new TextEncoder().encode('{"version":2,"secretish":"DAMAGED-CONTENT"}');
  const digest = 'ab'.repeat(32);
  const at = new Date('2027-01-15T08:00:00.000Z');

  it('is named by a strict zod schema and round-trips the damaged bytes exactly', () => {
    const text = keptAsideText(damaged, digest, at);
    const envelope = readKeptAside(text);
    expect(envelope).toEqual({
      keptBy: 'ferretry',
      kind: 'unreadable-fleet-manifest',
      keptAt: '2027-01-15T08:00:00.000Z',
      sha256: digest,
      bytes: Buffer.from(damaged).toString('base64'),
    });
    expect(Buffer.from(envelope?.bytes ?? '', 'base64')).toEqual(Buffer.from(damaged));
    expect(text.endsWith('\n')).toBe(true);
    expect(KeptAsideSchema.safeParse(JSON.parse(text)).success).toBe(true);
  });

  it('is only ours when every field is exactly right: nothing foreign, extra, missing or malformed parses', () => {
    const good = JSON.parse(keptAsideText(damaged, digest, at)) as Record<string, unknown>;
    const without = (key: string) => Object.fromEntries(Object.entries(good).filter(([name]) => name !== key));
    for (const odd of [
      { ...good, keptBy: 'someone' },
      { ...good, kind: 'something-else' },
      { ...good, keptAt: 'yesterday' },
      { ...good, sha256: 'ABC' },
      { ...good, sha256: 'AB'.repeat(32) },
      { ...good, bytes: 'not base64!!' },
      { ...good, bytes: 5 },
      { ...good, extra: true },
      without('bytes'),
      without('keptBy'),
    ])
      expect(readKeptAside(JSON.stringify(odd))).toBeUndefined();
    for (const text of ['', 'not json', '[]', 'null', '{"keptBy":"ferretry"}'])
      expect(readKeptAside(text)).toBeUndefined();
  });

  it('keeps at most 4 MiB of damage', () => {
    expect(MAX_KEPT_DAMAGE_BYTES).toBe(4 * 1024 * 1024);
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
