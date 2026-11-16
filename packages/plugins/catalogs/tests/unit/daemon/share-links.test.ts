/**
 * WHERE A SHARE LINK POINTS (Appendix D: P80, P81, R593), through the kernel test host: the link is drawn by the
 * same rule a pairing QR is, from what Connections advertises, and names no rendezvous.
 *
 * P81 and R593 are about the reader's browser not dialling a loopback `url` while it has a rendezvous: that walk is
 * the app half's (a later round). What the daemon half owes them is proved here: the link carries the loopback `url`
 * and the fingerprint and NOTHING about a rendezvous, so the browser discovers one itself.
 */
import { describe, expect, it } from 'bun:test';
import type { ConnectionAdvertisement } from '@ferretry/plugin-connections/contract';
import {
  APP_ORIGIN,
  browser,
  catalogsFixture,
  DISCOVERED_RELAY,
  LOOPBACK_ADVERTISEMENT,
  LOOPBACK_URL,
  makeCatalog,
} from '../../support/daemon-host.ts';

const PUBLIC_URL = 'https://studio.example.net';

async function mint(advertisement: ConnectionAdvertisement) {
  const fx = await catalogsFixture({ advertisement });
  const catalog = await makeCatalog(fx);
  const minted = await fx.host.request('POST', '/v1/catalog-shares', {
    body: { catalogIds: [catalog], member: { kind: 'new', label: 'Alice' }, expiresIn: '1h', uses: { kind: 'single' } },
  });
  const shares = await fx.host.request('GET', '/v1/catalog-shares');
  return {
    fx,
    minted,
    link: minted.status === 201 ? String(minted.json<{ link: string }>().link) : undefined,
    shares: shares.json<{ shares: unknown[] }>().shares,
  };
}

/** The fragment's `key=value` fields. */
function fragment(link: string): Map<string, string> {
  const [version, ...fields] = link.slice(link.indexOf('#') + 1).split(';');
  expect(version).toBe('v1');
  return new Map(
    fields.map(field => {
      const at = field.indexOf('=');
      return [field.slice(0, at), decodeURIComponent(field.slice(at + 1))] as const;
    }),
  );
}

describe('share links', () => {
  it('P80 should mint a link exactly where a pairing QR would be drawn, with the same loopback url and fp and no rendezvous', async () => {
    // Arrange / Act
    const loopback = await mint(LOOPBACK_ADVERTISEMENT);
    const unreachable = await mint({ ...LOOPBACK_ADVERTISEMENT, discoveredRelayUrl: undefined } as never);
    const published = await mint({
      ...LOOPBACK_ADVERTISEMENT,
      advertisement: { kind: 'address', url: PUBLIC_URL, origin: 'operator' },
      discoveredRelayUrl: undefined,
    } as never);
    const wildcard = await mint({
      ...LOOPBACK_ADVERTISEMENT,
      advertisement: { kind: 'none', refusal: 'wildcard-bind' },
    });

    // Assert — a loopback machine on a discoverable relay: the loopback url and the fingerprint, nothing else
    expect(loopback.minted.status).toBe(201);
    const fields = fragment(loopback.link ?? '');
    expect(loopback.link?.startsWith(`${APP_ORIGIN}/join#`)).toBe(true);
    expect(fields.get('url')).toBe(LOOPBACK_URL);
    expect(fields.get('fp')).toBe(loopback.fx.daemonId);
    expect(loopback.link).not.toContain(encodeURIComponent(DISCOVERED_RELAY));
    expect(loopback.link).not.toContain('relay.ferretry.test');
    expect([...fields.keys()].some(key => /relay|rendezvous|rv/iu.test(key))).toBe(false);
    // Assert — a public address goes in as it is; no reach, or a wildcard bind, is refused and spends nothing
    expect(fragment(published.link ?? '').get('url')).toBe(PUBLIC_URL);
    for (const refused of [unreachable, wildcard]) {
      expect(refused.minted.status).toBeGreaterThanOrEqual(400);
      expect(refused.shares).toEqual([]);
    }
  });

  it('P81 should hand the reader a loopback url with no rendezvous, so its browser finds one and dials it first', async () => {
    // Arrange
    const { fx, link } = await mint(LOOPBACK_ADVERTISEMENT);
    const fields = fragment(link ?? '');

    // Act — the browser joins over the relay it discovered, never told one by the link
    const end = await fx.open('relay').handshake();
    await end.join(await browser(), fields.get('share') ?? '');

    // Assert
    expect(fields.get('url')).toBe(LOOPBACK_URL);
    expect([...fields.values()].some(value => value.startsWith('wss:'))).toBe(false);
    expect(end.records[0]?.message.t).toBe('joined');
  });

  it('R593 should never name a rendezvous for a loopback url, so only an app opened on loopback tries it, last', async () => {
    // Arrange / Act
    const { link } = await mint(LOOPBACK_ADVERTISEMENT);
    const fields = fragment(link ?? '');

    // Assert — the only address in the link is the loopback one; the walk order is the reader's to decide
    const addresses = [...fields.values()].filter(value => /^(https?|wss?):/u.test(value));
    expect(addresses).toEqual([LOOPBACK_URL]);
  });
});
