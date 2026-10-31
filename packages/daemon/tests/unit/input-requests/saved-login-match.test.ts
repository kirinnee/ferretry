import { describe, it } from 'bun:test';
import type { InputTargetFacts, LoginEntrySummary } from '@ferretry/protocol';
import should from 'should';
import {
  remoteHostOf,
  savedFieldFor,
  savedFor,
  savedForFields,
  signInFor,
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
  program: comm,
  recognisedConsumer: true,
});

const browser = (origin: string): InputTargetFacts => ({
  kind: 'browser',
  pageId: 'p',
  origin,
  secure: true,
  navigationId: 'n',
  fields: [
    {
      fieldId: 'value',
      frameOrigin: origin,
      frameId: 'f',
      backendNodeId: 1,
      field: { tag: 'input', type: 'password' },
      box: { x: 0, y: 0, w: 1, h: 1 },
      visible: true,
    },
  ],
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

  it('should key nothing when the program is unproved, so a shell named sudo never gets the sudo login one-tap', () => {
    const disguised = { ...terminal('sudo', 'sudo -v'), program: undefined } as InputTargetFacts;
    should(targetMatchKey(disguised, 'kirin-box')).be.undefined();
    // The proved program decides, not the name the process gave itself.
    const proved = { ...terminal('bash', 'bash'), program: 'sudo' } as InputTargetFacts;
    should(targetMatchKey(proved, 'kirin-box')).equal('sudo@kirin-box');
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

describe('a page card matches where an entry signs in', () => {
  const google = entry('GOOGLE_KIRIN', ['accounts.google.com'], { label: 'Google (kirin@)', username: 'kirin@x.test' });
  const vercel = entry('VERCEL', ['vercel.com'], {
    label: 'Vercel',
    method: { kind: 'google', via: 'GOOGLE_KIRIN' },
    domains: ['vercel.com'],
    fields: { password: false, totp: false },
  });
  const app = entry('APP', ['app.example.com'], { domains: ['login.example.com'] });

  it("should make the provider's login the one tap on the provider's page", () => {
    const saved = savedFor('secret', 'accounts.google.com', [google, vercel, app], undefined);
    should(saved.offers.find(offer => offer.id === 'GOOGLE_KIRIN')?.matched).be.true();
    should(saved.signIn).be.undefined();
  });

  it('should match a page by the login domain, not by what the entry is for', () => {
    should(savedFor('secret', 'login.example.com', [app], undefined).offers[0]?.matched).be.true();
    should(savedFor('secret', 'app.example.com', [app], undefined).offers[0]?.matched).be.false();
  });

  it('should match a login domain exactly: a parent, a child or a look-alike is not it', () => {
    for (const key of [
      'google.com',
      'evil.accounts.google.com',
      'accounts.google.com.evil.test',
      'accounts-google.com',
    ])
      should(savedFor('secret', key, [google], undefined).offers[0]?.matched).be.false();
  });

  it('should still match an entry from before login domains by its web hosts', () => {
    const old = entry('GITHUB', ['github.com']);
    should(savedFor('secret', 'github.com', [old], undefined).offers[0]?.matched).be.true();
  });

  it('should keep matching a terminal by what the entry is for', () => {
    const sudo = entry('SUDO', ['sudo@kirin-box'], { domains: [] });
    should(savedFor('secret', 'sudo@kirin-box', [sudo], undefined).offers[0]?.matched).be.true();
  });

  it('should say on the card how a site that goes via a provider signs in, never offering the provider here', () => {
    const saved = savedFor('secret', 'vercel.com', [google, vercel], undefined);
    should(saved.signIn).deepEqual({
      id: 'VERCEL',
      label: 'Vercel',
      method: { kind: 'google', via: 'GOOGLE_KIRIN' },
      via: { id: 'GOOGLE_KIRIN', label: 'Google (kirin@)' },
    });
    should(saved.offers.some(offer => offer.matched)).be.false();
    should(saved.offers.map(offer => offer.id)).not.containEql('GOOGLE_KIRIN');
    should(signInFor('sudo@kirin-box', [google, vercel])).be.undefined();
  });

  it('should say it on a card of several fields too', () => {
    const fields = [
      { id: 'email', sensitivity: 'plain' as const },
      { id: 'password', sensitivity: 'secret' as const },
    ];
    const saved = savedForFields(fields, 'vercel.com', [google, vercel], undefined);
    should(saved.signIn?.via?.id).equal('GOOGLE_KIRIN');
    should(saved.offers.map(offer => offer.id)).not.containEql('GOOGLE_KIRIN');
  });
});

describe('a provider login the owner also signs in with on the site', () => {
  it('should still offer it where its own login domains make it matched', () => {
    const google = entry('GOOGLE_KIRIN', ['accounts.google.com'], {
      label: 'Google (kirin@)',
      domains: ['accounts.google.com', 'vercel.com'],
    });
    const vercel = entry('VERCEL', ['vercel.com'], {
      method: { kind: 'google', via: 'GOOGLE_KIRIN' },
      domains: ['vercel.com'],
      fields: { password: false, totp: false },
    });
    const saved = savedFor('secret', 'vercel.com', [google, vercel], undefined);
    should(saved.offers.find(offer => offer.id === 'GOOGLE_KIRIN')?.matched).be.true();
  });
});
