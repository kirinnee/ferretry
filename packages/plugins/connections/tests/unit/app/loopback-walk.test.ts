/**
 * R593 through the app shell's REAL dial order (`memberWalk`, the walk every join and member session takes over what
 * Connections advertises): a loopback `url` names the reader's own computer, so it is not dialled while a rendezvous
 * exists, and only an app opened on loopback tries it, last. The catalogs suite proves the daemon half (a share link
 * names no rendezvous); this is the walk that decides what the browser then dials.
 */
import { describe, expect } from 'bun:test';
import { type MemberPublisher, memberWalk } from '@ferretry/app';
import { guarantee } from '../../support/guarantee.ts';

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

describe('the dial order over a loopback url', () => {
  guarantee(
    ['R593'],
    'should never dial a loopback url while a rendezvous exists, so only an app opened on loopback tries it, last',
    () => {
      // Arrange — a loopback publisher address, then each way a rendezvous can exist beside it
      const published = publisher({
        carriers: [
          { kind: 'relay', url: PUBLISHED_RELAY },
          { kind: 'direct', url: PUBLISHED_DIRECT },
        ],
      });

      // Act / Assert — a join, from a hosted page: the one discovered rendezvous, the loopback url never dialled
      expect(
        dialled(memberWalk(publisher(), 'join', { rendezvousUrl: RENDEZVOUS, servedFromLoopback: false })),
      ).toEqual([RENDEZVOUS]);
      // a member session, from a hosted page: every relay and published direct address, still no loopback url
      expect(
        dialled(memberWalk(published, 'member', { rendezvousUrl: RENDEZVOUS, servedFromLoopback: false })),
      ).toEqual([PUBLISHED_DIRECT, PUBLISHED_RELAY, RENDEZVOUS]);
      // an app opened on loopback tries it, and LAST — after the rendezvous, never before it
      expect(dialled(memberWalk(publisher(), 'join', { rendezvousUrl: RENDEZVOUS, servedFromLoopback: true }))).toEqual(
        [RENDEZVOUS, LOOPBACK_URL],
      );
      expect(dialled(memberWalk(published, 'member', { rendezvousUrl: RENDEZVOUS, servedFromLoopback: true }))).toEqual(
        [PUBLISHED_DIRECT, PUBLISHED_RELAY, RENDEZVOUS, LOOPBACK_URL],
      );
      // with no rendezvous at all the loopback url is the only way there is, so it is kept
      expect(dialled(memberWalk(publisher(), 'join', { servedFromLoopback: false }))).toEqual([LOOPBACK_URL]);
    },
  );
});
