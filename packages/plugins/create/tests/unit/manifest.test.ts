import { describe, expect, test } from 'bun:test';
import { exactNetworkHosts } from '../../../../core/kernel/host/secrets.ts';
import { isFalCdn } from '../../daemon/lib/generate-image.ts';
import manifest from '../../manifest.ts';

describe('what Create may reach and spend', () => {
  test('one tool, no route, no verb: a ferret’s tool and nothing a browser can call', () => {
    expect(manifest.actions.agentTools.map(tool => tool.name)).toEqual(['generate_image']);
    expect('routes' in manifest.actions).toBe(false);
  });

  test('the key is declared by name and can only be placed on fal’s two API hosts', () => {
    expect(manifest.permissions?.secrets).toEqual(['FAL_KEY']);
    // a wildcard entry lets no key out (docs/secrets.md): the CDN is fetched with none
    expect(exactNetworkHosts(manifest.permissions?.network ?? [])).toEqual(['fal.run', 'api.fal.ai']);
  });

  test('the ledger is private to the owner and the ask source is registered', () => {
    expect(manifest.privacy?.private).toEqual(['ledger.jsonl']);
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
