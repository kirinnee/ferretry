import { describe, expect, it } from 'bun:test';
import { formatShareFragment } from '@ferretry/protocol';
import { classifyCatalogLink, LINK_DAMAGED, LINK_EMPTY, LINK_OTHER, LINK_PAIRING } from '../../src/lib/catalog-link.ts';
import { FAKE_CODE } from '../support/catalog-sharing.ts';

const FP = `fy_daemon_${'q'.repeat(43)}`;
const fragment = formatShareFragment({ daemonUrl: 'https://box.example.test', daemonId: FP, code: FAKE_CODE } as never);
const join = (origin: string, hash: string): string => `${origin}/join${hash}`;

describe('classifyCatalogLink', () => {
  it('asks for a link when nothing is pasted', () => {
    expect(classifyCatalogLink('   ')).toEqual({ kind: 'empty', sentence: LINK_EMPTY });
  });

  it('reads a share link and hands back its fragment', () => {
    const link = classifyCatalogLink(`  ${join('https://app.example.test', `#${fragment}`)}  `);
    expect(link.kind).toBe('join');
    expect(link.kind === 'join' && link.fragment.startsWith('#v1;')).toBe(true);
  });

  it('reads a share link made for another copy of the app by its path and fragment', () => {
    expect(classifyCatalogLink(`${join('https://other.example.org', `#${fragment}`)}`).kind).toBe('join');
    expect(
      classifyCatalogLink(`${join('https://app.example.test', `#${fragment}`)}`.replace('/join', '/join/')).kind,
    ).toBe('join');
  });

  it('calls a join link with a broken fragment damaged', () => {
    expect(classifyCatalogLink(join('https://app.example.test', '#v1;url=nope'))).toEqual({
      kind: 'damaged',
      sentence: LINK_DAMAGED,
    });
    expect(classifyCatalogLink(join('https://app.example.test', '')).kind).toBe('damaged');
  });

  it('says a pairing link is for a device', () => {
    const pairing = `https://app.example.test/#v1;url=https%3A%2F%2Fbox.example.test;fp=${FP};code=ABCDEFGH`;
    expect(classifyCatalogLink(pairing)).toEqual({ kind: 'pairing', sentence: LINK_PAIRING });
  });

  it('names anything else as not a share link', () => {
    expect(classifyCatalogLink('https://example.com/skills')).toEqual({ kind: 'other', sentence: LINK_OTHER });
    expect(classifyCatalogLink('not a link at all')).toEqual({ kind: 'other', sentence: LINK_OTHER });
  });
});
