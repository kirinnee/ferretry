/**
 * R593, in the owner's suite: the app shell's REAL dial order (`memberWalk`, the walk every join and member session takes
 * over what Connections advertises). A loopback `url` names the reader's own computer, so it is not dialled while a
 * rendezvous exists, and only an app opened on loopback tries it, last. The daemon half (a share link names no
 * rendezvous for a loopback url) is Catalogs' and is proved in its suite.
 */
import { expect, test } from 'bun:test';
import { type MemberPublisher, memberWalk } from '../../../src/connect/member.ts';

const DAEMON = `fy_daemon_${'a'.repeat(43)}`;
const LOOPBACK_URL = 'http://127.0.0.1:7777';
const RENDEZVOUS = 'wss://relay.example.test';
const PUBLISHED_RELAY = 'wss://published.example.test';
const PUBLISHED_DIRECT = 'https://alt.example.test';

const publisher = (extra: Partial<MemberPublisher> = {}): MemberPublisher => ({
  daemonId: DAEMON,
  daemonUrl: LOOPBACK_URL,
  ...extra,
});
const dialled = (steps: ReturnType<typeof memberWalk>) => steps.map(step => step.address);

test('R593 a loopback url is not dialled while a rendezvous exists: a hosted page never tries it', () => {
  const published = publisher({
    carriers: [
      { kind: 'relay', url: PUBLISHED_RELAY },
      { kind: 'direct', url: PUBLISHED_DIRECT },
    ],
  });

  // a join from a hosted page: the one discovered rendezvous, the loopback url never dialled
  expect(dialled(memberWalk(publisher(), 'join', { rendezvousUrl: RENDEZVOUS, servedFromLoopback: false }))).toEqual([
    RENDEZVOUS,
  ]);
  // a member session from a hosted page: every published address and the rendezvous, still no loopback url
  expect(dialled(memberWalk(published, 'member', { rendezvousUrl: RENDEZVOUS, servedFromLoopback: false }))).toEqual([
    PUBLISHED_DIRECT,
    PUBLISHED_RELAY,
    RENDEZVOUS,
  ]);
});

test('R593 only an app opened on loopback tries the loopback url, and last, after the rendezvous', () => {
  const published = publisher({
    carriers: [
      { kind: 'relay', url: PUBLISHED_RELAY },
      { kind: 'direct', url: PUBLISHED_DIRECT },
    ],
  });

  expect(dialled(memberWalk(publisher(), 'join', { rendezvousUrl: RENDEZVOUS, servedFromLoopback: true }))).toEqual([
    RENDEZVOUS,
    LOOPBACK_URL,
  ]);
  expect(dialled(memberWalk(published, 'member', { rendezvousUrl: RENDEZVOUS, servedFromLoopback: true }))).toEqual([
    PUBLISHED_DIRECT,
    PUBLISHED_RELAY,
    RENDEZVOUS,
    LOOPBACK_URL,
  ]);
});

test('R593 with no rendezvous at all the loopback url is the only way there is, so it is kept', () => {
  expect(dialled(memberWalk(publisher(), 'join', { servedFromLoopback: false }))).toEqual([LOOPBACK_URL]);
});
