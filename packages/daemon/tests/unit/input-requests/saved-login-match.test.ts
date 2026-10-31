import { describe, it } from 'bun:test';
import type { InputTargetFacts, LoginEntrySummary } from '@ferretry/protocol';
import should from 'should';
import {
  remoteHostOf,
  savedFieldFor,
  savedFor,
  shortHost,
  targetMatchKey,
} from '../../../src/lib/input-requests/saved-logins.ts';

const terminal = (comm: string, argv: string): InputTargetFacts => ({
  kind: 'terminal',
  paneProof: { paneId: '%3', pid: 1 },
  foreground: { pid: 2, pgid: 2, comm, argv },
  echo: 'off',
  cursorRow: 0,
  promptLine: '',
  promptLineDigest: 'a'.repeat(64),
  recognisedConsumer: true,
});

const browser = (origin: string): InputTargetFacts => ({
  kind: 'browser',
  pageId: 'p',
  origin,
  secure: true,
  frameOrigin: origin,
  navigationId: 'n',
  backendNodeId: 1,
  field: { tag: 'input', type: 'password' },
  box: { x: 0, y: 0, w: 1, h: 1 },
  visible: true,
});

const entry = (id: string, match: string[], extra: Partial<LoginEntrySummary> = {}): LoginEntrySummary => ({
  id,
  label: id.toLowerCase(),
  match,
  fields: { password: true, totp: false },
  createdAt: 'a',
  updatedAt: 'a',
  ...extra,
});

describe('which saved login is for a target', () => {
  it('should key a local program by this machine’s short name', () => {
    should(targetMatchKey(terminal('sudo', 'sudo -v'), 'Kirin-Box.local')).equal('sudo@kirin-box');
    should(targetMatchKey(terminal('gpg', 'gpg --sign'), 'laptop')).equal('gpg@laptop');
    should(shortHost('  ')).be.undefined();
    should(targetMatchKey(terminal('sudo', 'sudo'), '')).be.undefined();
  });

  it('should key ssh, scp and sftp by the destination on the command line', () => {
    should(targetMatchKey(terminal('ssh', 'ssh -p 2222 -i key kirin@Build.Example.com'), 'box')).equal(
      'ssh@build.example.com',
    );
    should(targetMatchKey(terminal('scp', 'scp -P 22 file.txt'), 'box')).equal('scp@file.txt');
    should(remoteHostOf('ssh -o StrictHostKeyChecking=no -- host.example')).equal('host.example');
    should(remoteHostOf('ssh ssh://kirin@host.example:2222')).equal('host.example');
    should(remoteHostOf('ssh -v')).be.undefined();
    should(targetMatchKey(terminal('ssh', 'ssh -v'), 'box')).be.undefined();
  });

  it('should key a page by its origin’s host, and nothing for an origin it cannot read', () => {
    should(targetMatchKey(browser('https://GitHub.com'), 'box')).equal('github.com');
    should(targetMatchKey(browser('https://localhost:8443'), 'box')).equal('localhost:8443');
    should(targetMatchKey(browser('not a url'), 'box')).be.undefined();
  });
});

describe('what a card offers', () => {
  it('should offer only entries holding the field, matched first, then hinted, then by label', () => {
    const saved = savedFor(
      'secret',
      'sudo@box',
      [
        entry('ZED', ['sudo@other']),
        entry('ALPHA', ['sudo@other']),
        entry('HINTED', ['x@y']),
        entry('MATCH', ['sudo@box']),
        entry('NO_PASSWORD', ['sudo@box'], { fields: { password: false, totp: false } }),
      ],
      'HINTED',
    );
    should(saved.offers.map(offer => [offer.id, offer.matched, offer.hinted === true])).deepEqual([
      ['MATCH', true, false],
      ['HINTED', false, true],
      ['ALPHA', false, false],
      ['ZED', false, false],
    ]);
    should(saved.suggest).deepEqual({ id: 'MATCH', label: 'match' });
  });

  it('should suggest a new entry from the key when none matches, and nothing to save for a code', () => {
    should(savedFor('secret', 'sudo@box', [], undefined)).deepEqual({
      match: 'sudo@box',
      suggest: { id: 'SUDO_BOX', label: 'sudo on box' },
      saves: 'password',
      offers: [],
    });
    should(savedFor('private', 'sudo@box', [], undefined)).deepEqual({ match: 'sudo@box', offers: [] });
    should(savedFor('plain', undefined, [entry('U', [], { username: 'kirin' })], undefined)).deepEqual({
      saves: 'username',
      offers: [{ id: 'U', label: 'u', username: 'kirin', fills: 'username', matched: false }],
    });
  });

  it('should save a secret as the password, plain as the username and never a code', () => {
    should(savedFieldFor('secret')).equal('password');
    should(savedFieldFor('plain')).equal('username');
    should(savedFieldFor('private')).be.undefined();
  });
});
