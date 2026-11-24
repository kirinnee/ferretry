import { describe, expect, test } from 'bun:test';
import { exactNetworkHosts } from '../../../../core/kernel/host/secrets.ts';
import { isFalCdn } from '../../daemon/lib/paid-call.ts';
import manifest from '../../manifest.ts';

describe('what Create may reach and spend', () => {
  test('five tools and the status read, no route, no verb: a ferret’s tools and nothing a browser can call', () => {
    expect(manifest.actions.agentTools.map(tool => tool.name)).toEqual([
      'generate_image',
      'generate_speech',
      'generate_sfx',
      'generate_music',
      'generate_video',
      'generation_status',
    ]);
    expect('routes' in manifest.actions).toBe(false);
  });

  test('the keys are declared by name and can only be placed on the API hosts, never on the CDN', () => {
    expect(manifest.permissions?.secrets).toEqual(['FAL_KEY', 'ELEVENLABS_API_KEY']);
    // a wildcard entry lets no key out (docs/secrets.md): the CDN is fetched with none
    expect(exactNetworkHosts(manifest.permissions?.network ?? [])).toEqual([
      'fal.run',
      'queue.fal.run',
      'api.fal.ai',
      'api.elevenlabs.io',
    ]);
  });

  test('the ledger and the video jobs are private to the owner and the ask source is registered', () => {
    expect(manifest.privacy?.private).toEqual(['ledger.jsonl', 'jobs.jsonl']);
    expect(manifest.hooks?.takes.map(take => (take as { key?: string }).key)).toEqual(['create-spend']);
  });
});

describe('the picture is fetched from fal’s storage only', () => {
  test('https on a fal.media subdomain, no userinfo', () => {
    expect(isFalCdn('https://v3.fal.media/files/a/b.jpg')).toBe(true);
    expect(isFalCdn('http://v3.fal.media/files/a/b.jpg')).toBe(false);
    expect(isFalCdn('https://fal.media/x')).toBe(false);
    expect(isFalCdn('https://evil.example/x.fal.media')).toBe(false);
    expect(isFalCdn('https://fal.media.evil.example/x')).toBe(false);
    expect(isFalCdn('https://user:pw@v3.fal.media/x')).toBe(false);
    expect(isFalCdn('not a url')).toBe(false);
  });
});
