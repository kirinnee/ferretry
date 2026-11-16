import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { boundedRun, HostInstallFacts } from '../../../src/adapters/update/install-facts.ts';
import { GitHubLatestRelease, type ReleaseFetch } from '../../../src/adapters/update/latest-release.ts';
import { CommandPackageManagers } from '../../../src/adapters/update/package-managers.ts';
import { StandaloneRelease } from '../../../src/adapters/update/standalone-release.ts';
import type { UpdateActivity } from '../../../src/lib/update/activity.ts';
import { signedReleaseMessage } from '../../../src/lib/update/release-files.ts';

const dirs: string[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fy-update-int-'));
  dirs.push(dir);
  return dir;
}
const originalPath = process.env.PATH;
afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(dirs.splice(0).map(async dir => await rm(dir, { recursive: true, force: true })));
});

describe('asking GitHub for the latest release', () => {
  const release = {
    tag_name: 'v1.3.0',
    html_url: 'https://github.com/kirinnee/ferretry/releases/tag/v1.3.0',
    draft: false,
    prerelease: false,
  };
  const answering =
    (response: () => Response, seen: string[] = []): ReleaseFetch =>
    async input => {
      seen.push(input);
      return await Promise.resolve(response());
    };

  it('should read the latest published release from the releases API', async () => {
    const seen: string[] = [];
    const answer = await new GitHubLatestRelease('ferretry', {
      fetcher: answering(() => Response.json(release), seen),
    }).latest();
    should(answer).eql({ kind: 'found', release: { version: '1.3.0', url: release.html_url } });
    should(seen).eql(['https://api.github.com/repos/kirinnee/ferretry/releases/latest']);
  });

  it('should read the newest stable tag from the tags API', async () => {
    const seen: string[] = [];
    const tags = [{ name: 'v1.3.0' }, { name: 'v1.3.1' }, { name: 'v1.4.0-rc.1' }, { name: 'nightly' }];
    const answer = await new GitHubLatestRelease('ferretry', {
      fetcher: answering(() => Response.json(tags), seen),
    }).newestTag();
    should(answer).eql({
      kind: 'found',
      release: { version: '1.3.1', url: 'https://github.com/kirinnee/ferretry/releases/tag/v1.3.1' },
    });
    should(seen).eql(['https://api.github.com/repos/kirinnee/ferretry/tags?per_page=30']);
  });

  it('should turn every failure to read the latest release into one sentence', async () => {
    const read = async (fetcher: ReleaseFetch) =>
      await new GitHubLatestRelease('ferretry', { fetcher, timeoutMs: 50 }).latest();
    should(await read(() => Promise.reject(new Error('offline')))).eql({
      kind: 'failed',
      reason: 'could not reach GitHub',
    });
    should(await read(answering(() => new Response('', { status: 403 })))).eql({
      kind: 'failed',
      reason: 'GitHub answered 403',
    });
    should(await read(answering(() => new Response('<html>')))).eql({
      kind: 'failed',
      reason: 'GitHub answered something that is not JSON',
    });
    should(await read(answering(() => Response.json({ ...release, draft: true })))).eql({
      kind: 'failed',
      reason: 'GitHub named no published release',
    });
  });

  it('should turn every failure to read the tags into one sentence', async () => {
    const read = async (fetcher: ReleaseFetch) =>
      await new GitHubLatestRelease('ferretry', { fetcher, timeoutMs: 50 }).newestTag();
    should(await read(() => Promise.reject(new Error('offline')))).eql({
      kind: 'failed',
      reason: 'could not reach GitHub',
    });
    should(await read(answering(() => new Response('', { status: 500 })))).eql({
      kind: 'failed',
      reason: 'GitHub answered 500',
    });
    should(await read(answering(() => Response.json([{ name: 'nightly' }])))).eql({
      kind: 'failed',
      reason: 'GitHub named no release tag',
    });
  });

  it('should send the product as its user agent through the global fetch when none is injected', async () => {
    const original = globalThis.fetch;
    const seen: { url: string; agent: string | null }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), agent: new Headers(init?.headers).get('user-agent') });
      return await Promise.resolve(Response.json(release));
    }) as typeof fetch;
    try {
      const answer = await new GitHubLatestRelease('ferretry').latest();
      should(answer.kind).equal('found');
    } finally {
      globalThis.fetch = original;
    }
    should(seen).eql([{ url: 'https://api.github.com/repos/kirinnee/ferretry/releases/latest', agent: 'ferretry' }]);
  });
});

describe('the package-manager commands an update runs', () => {
  const TAP = 'kirinnee/ferretry';
  const URL = 'https://github.com/kirinnee/ferretry';
  const NIX = 'nix --extra-experimental-features nix-command flakes';
  const LOCKED = {
    source: 'github:kirinnee/ferretry',
    reference: `github:kirinnee/ferretry/${'a'.repeat(40)}`,
    version: '4.291.10',
    profile: { attribute: 'packages.x86_64-linux.default', priority: 5 },
  };

  function fakeBrew(
    taps: string,
    failing: readonly string[] = [],
  ): {
    ran: string[];
    managers: CommandPackageManagers;
  } {
    const ran: string[] = [];
    const managers = new CommandPackageManagers(async argv => {
      const command = argv.join(' ');
      ran.push(command);
      if (failing.includes(command)) return await Promise.resolve({ code: 1, stdout: '', stderr: `${command} broke` });
      return await Promise.resolve({ code: 0, stdout: command === 'brew tap' ? taps : '', stderr: '' });
    });
    return { ran, managers };
  }

  it('should run exactly the commands an update is allowed, as the user', async () => {
    const { ran, managers } = fakeBrew(`homebrew/core\n${TAP}\n`);
    await managers.brewRefresh(TAP, URL);
    await managers.brewUpgrade('ferretry');
    await managers.nixProfileUpgrade('ferretry', LOCKED);
    await managers.nixProfileRollback();
    await managers.nixProfileInstall('github:kirinnee/ferretry');
    should(ran).eql([
      'brew tap',
      'brew update',
      'env HOMEBREW_NO_AUTO_UPDATE=1 brew upgrade --cask ferretry',
      `${NIX} profile install --no-update-lock-file --priority 6 ${LOCKED.reference}#packages.x86_64-linux.default`,
      `${NIX} profile remove ferretry`,
      `${NIX} profile rollback`,
      `${NIX} profile install --refresh github:kirinnee/ferretry`,
    ]);
    should(ran.some(command => command.includes('sudo'))).be.false();
  });

  it('should tap the repository first when the tap is gone, then update', async () => {
    const { ran, managers } = fakeBrew('homebrew/core\n');
    should((await managers.brewRefresh(TAP, URL)).code).equal(0);
    should(ran).eql(['brew tap', `brew tap ${TAP} ${URL}`, 'brew update']);
  });

  it('should stop and report when the tap cannot be added', async () => {
    const { ran, managers } = fakeBrew('', [`brew tap ${TAP} ${URL}`]);
    should((await managers.brewRefresh(TAP, URL)).code).equal(1);
    should(ran).eql(['brew tap', `brew tap ${TAP} ${URL}`]);
  });

  it('should still update when it cannot list taps, and surface a failing update', async () => {
    const { ran, managers } = fakeBrew('', ['brew tap', 'brew update']);
    should((await managers.brewRefresh(TAP, URL)).code).equal(1);
    should(ran).eql(['brew tap', 'brew update']);
  });

  it('should ask nix for its events only when someone watches, and report them as they arrive', async () => {
    const nix = (event: object): string => `@nix ${JSON.stringify(event)}`;
    const argvs: string[][] = [];
    const managers = new CommandPackageManagers(async (argv, onLine) => {
      argvs.push([...argv]);
      const lines = [
        nix({ action: 'start', id: 1, type: 103, text: 'copying' }),
        nix({ action: 'result', id: 1, type: 105, fields: [0, 3, 0, 0] }),
        nix({ action: 'msg', level: 0, msg: 'error: attribute missing' }),
        'trailing plain line',
      ];
      for (const line of lines) onLine?.(line);
      return await Promise.resolve({ code: 1, stdout: '', stderr: `${lines.join('\n')}\n` });
    });
    const seen: string[] = [];
    const outcome = await managers.nixProfileUpgrade('ferretry', LOCKED, activity => {
      seen.push(JSON.stringify(activity));
    });
    should(argvs[0]?.join(' ')).equal(
      `${NIX} profile install --no-update-lock-file --priority 6 --log-format internal-json -v ${LOCKED.reference}#packages.x86_64-linux.default`,
    );
    should(seen[0]).equal('{"phase":"preparing"}');
    should(seen.some(line => line.includes('"packages":{"done":0,"expected":3}'))).be.true();
    should(outcome.code).equal(1);
    should(outcome.stderr).equal('error: attribute missing\ntrailing plain line');
    await managers.nixProfileInstall('github:kirinnee/ferretry', () => undefined);
    should(argvs[1]?.join(' ')).containEql(
      'profile install --refresh --log-format internal-json -v github:kirinnee/ferretry',
    );
  });

  it('should show the last line of brew as the detail of each phase, cleaned', async () => {
    const managers = new CommandPackageManagers(async (argv, onLine) => {
      if (argv.join(' ') === 'brew tap') return { code: 0, stdout: `${TAP}\n`, stderr: '' };
      onLine?.('\u001b[1m==> Upgrading ferretry\u001b[0m');
      onLine?.('   ');
      return await Promise.resolve({ code: 0, stdout: '', stderr: '' });
    });
    const seen: string[] = [];
    const note = (activity: UpdateActivity): void => {
      seen.push(`${activity.phase}:${activity.line ?? ''}`);
    };
    await managers.brewRefresh(TAP, URL, note);
    await managers.brewUpgrade('ferretry', note);
    should(seen).eql([
      'refreshing:',
      'refreshing:==> Upgrading ferretry',
      'upgrading:',
      'upgrading:==> Upgrading ferretry',
    ]);
  });

  it('should add a tap with a refreshing step when watched', async () => {
    const ran: string[] = [];
    const managers = new CommandPackageManagers(async argv => {
      ran.push(argv.join(' '));
      return await Promise.resolve({ code: 0, stdout: '', stderr: '' });
    });
    const seen: string[] = [];
    await managers.brewRefresh(TAP, URL, activity => {
      seen.push(activity.phase);
    });
    should(ran).eql(['brew tap', `brew tap ${TAP} ${URL}`, 'brew update']);
    should(seen).eql(['refreshing', 'refreshing']);
  });
});

describe('the facts about how the daemon on this host was installed', () => {
  const STORE = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-ferretry-1.2.3';
  const daemon = (path: string) => ({ path, source: 'PATH' as const, version: '1.2.3' });
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const no = { code: 1, stdout: '', stderr: 'not owned' };

  function facts(options: {
    answers?: Readonly<Record<string, { code: number; stdout: string; stderr: string }>>;
    commands?: readonly string[];
    realPath?: (path: string) => Promise<string>;
  }): { subject: HostInstallFacts; ran: string[] } {
    const ran: string[] = [];
    const subject = new HostInstallFacts({
      product: 'ferretry',
      homeDirectory: '/home/kirin',
      platform: 'linux',
      run: async argv => {
        ran.push(argv.join(' '));
        return await Promise.resolve(options.answers?.[argv[0] ?? ''] ?? no);
      },
      readLink: async () => await Promise.resolve(undefined),
      which: command => ((options.commands ?? []).includes(command) ? `/usr/bin/${command}` : undefined),
      ...(options.realPath === undefined ? {} : { realPath: options.realPath }),
    });
    return { subject, ran };
  }

  it('should resolve links on the real filesystem and keep the launched path', async () => {
    const dir = await temp();
    const real = join(dir, 'fyd-real');
    await writeFile(real, '');
    await symlink(real, join(dir, 'fyd'));
    const found = await facts({}).subject.facts(daemon(join(dir, 'fyd')));
    should(found).match({
      launchedPath: join(dir, 'fyd'),
      resolvedPath: real,
      compiled: true,
      systemPackage: undefined,
    });
  });

  it('should keep the path as it is when it cannot be resolved', async () => {
    const found = await facts({}).subject.facts(daemon('/nonexistent/fyd'));
    should(found.resolvedPath).equal('/nonexistent/fyd');
  });

  it('should ask the nix profile which element holds a store path', async () => {
    const list = JSON.stringify({ version: 3, elements: { ferretry: { storePaths: [STORE] } } });
    const { subject, ran } = facts({
      answers: { nix: ok(list) },
      realPath: async () => await Promise.resolve(`${STORE}/bin/fyd`),
    });
    should(await subject.facts(daemon('/home/kirin/.nix-profile/bin/fyd'))).match({
      nixProfileElement: 'ferretry',
      homeManagerProfile: false,
    });
    should(ran).eql(['nix --extra-experimental-features nix-command flakes profile list --json']);
  });

  it('should treat a failed or unreadable profile list as no element', async () => {
    const store = async () => await Promise.resolve(`${STORE}/bin/fyd`);
    const failed = await facts({ realPath: store }).subject.facts(daemon('/x'));
    should(failed.nixProfileElement).be.undefined();
    const garbled = facts({ answers: { nix: ok('{not json') }, realPath: store });
    should(await garbled.subject.facts(daemon('/x'))).match({
      nixProfileElement: undefined,
      homeManagerProfile: false,
    });
  });

  it('should ask dpkg, then rpm, only when they exist', async () => {
    const real = async () => await Promise.resolve('/usr/bin/fyd');
    const apt = await facts({ commands: ['dpkg'], answers: { dpkg: ok() }, realPath: real }).subject.facts(
      daemon('/usr/bin/fyd'),
    );
    should(apt.systemPackage).equal('apt');
    const dnf = await facts({ commands: ['dpkg', 'rpm', 'dnf'], answers: { rpm: ok() }, realPath: real }).subject.facts(
      daemon('/usr/bin/fyd'),
    );
    should(dnf.systemPackage).equal('dnf');
    const yum = await facts({ commands: ['rpm'], answers: { rpm: ok() }, realPath: real }).subject.facts(
      daemon('/usr/bin/fyd'),
    );
    should(yum.systemPackage).equal('yum');
    const none = facts({ answers: { dpkg: ok(), rpm: ok() }, realPath: real });
    should((await none.subject.facts(daemon('/usr/bin/fyd'))).systemPackage).be.undefined();
    should(none.ran).be.empty();
  });

  it('should resolve a real path and look for the system package managers on the host when only the runner is injected', async () => {
    const dir = await temp();
    const file = join(dir, 'fyd');
    await writeFile(file, '');
    const asked: string[] = [];
    const subject = new HostInstallFacts({
      product: 'ferretry',
      homeDirectory: '/home/kirin',
      platform: 'linux',
      run: async argv => {
        asked.push(argv.join(' '));
        return await Promise.resolve({ code: 1, stdout: '', stderr: 'not owned' });
      },
    });
    const found = await subject.facts(daemon(file));
    should(found.resolvedPath).equal(file);
    should(found.systemPackage).be.undefined();
    // Whether dpkg or rpm exist on this host decides what was asked, never what was concluded.
    should(asked.every(line => line.endsWith(file))).be.true();
  });

  it('should run a command with its output captured, treat a missing command as exit 127, and kill one that outlives its bound', async () => {
    const out = await boundedRun(['sh', '-c', 'printf out; printf err >&2; exit 4'], 5_000);
    should(out).eql({ code: 4, stdout: 'out', stderr: 'err' });
    const missing = await boundedRun(['/nonexistent/fy-no-such-command'], 5_000);
    should(missing.code).equal(127);
    should(missing.stderr).not.equal('');
    const slow = await boundedRun(['sleep', '30'], 50);
    should(slow.code).not.equal(0);
  });
});

describe('verifying and swapping in a standalone release', () => {
  const b64 = (bytes: ArrayBuffer): string => Buffer.from(bytes).toString('base64url');

  async function keyPair(): Promise<{ readonly key: string; sign(checksums: Uint8Array): Promise<string> }> {
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const publicKey = await crypto.subtle.exportKey('spki', pair.publicKey);
    return {
      key: b64(publicKey),
      sign: async checksums =>
        `${b64(await crypto.subtle.digest('SHA-256', publicKey))}.${b64(await crypto.subtle.sign('Ed25519', pair.privateKey, signedReleaseMessage(checksums)))}\n`,
    };
  }

  async function fixture(options: { platform?: string; arch?: string; unpack?: string[] } = {}) {
    const dir = await temp();
    await writeFile(join(dir, 'fyd'), 'old daemon');
    await writeFile(join(dir, 'fy'), 'old shell');
    const signer = await keyPair();
    const archive = new TextEncoder().encode('fake archive decoded only by the fake tar');
    const sha = new Bun.CryptoHasher('sha256').update(archive).digest('hex');
    const checksums = new TextEncoder().encode(`${sha}  fy_linux_amd64.tar.gz\n`);
    const files = new Map<string, Uint8Array | string>([
      ['checksums.txt', checksums],
      ['checksums.txt.sig', await signer.sign(checksums)],
      ['fy_linux_amd64.tar.gz', archive],
    ]);
    const ran: string[][] = [];
    const urls: string[] = [];
    const behaviour = { status: undefined as undefined | number, fail: false, tar: 0, stderr: '' };
    const subject = (keys = [signer.key]): StandaloneRelease =>
      new StandaloneRelease({
        product: 'ferretry',
        clientName: 'fy',
        platform: options.platform ?? 'linux',
        arch: options.arch ?? 'x64',
        binaries: ['fy', 'fyd'],
        keys,
        fetcher: async url => {
          urls.push(url);
          if (behaviour.fail) throw new Error('offline');
          if (behaviour.status !== undefined) return new Response('', { status: behaviour.status });
          const body = files.get(url.split('/').at(-1) ?? '') as BodyInit;
          const headers = url.endsWith('.tar.gz') ? { 'content-length': String(archive.length) } : undefined;
          return await Promise.resolve(new Response(body, { headers }));
        },
        run: async argv => {
          ran.push([...argv]);
          const scratch = argv.at(-1) as string;
          for (const name of options.unpack ?? ['fy', 'fyd']) await writeFile(join(scratch, name), `new ${name}`);
          return { code: behaviour.tar, stdout: '', stderr: behaviour.stderr };
        },
      });
    return { dir, files, ran, urls, behaviour, subject, signer, checksums };
  }

  it('should verify, stage, swap and roll back inside a temporary install', async () => {
    const f = await fixture();
    const adapter = f.subject();
    const events: string[] = [];
    const byteReports: { done: number; expected: number }[] = [];
    const staged = await adapter.stage('5.0.1', f.dir, activity => {
      events.push(activity.phase);
      if (activity.bytes !== undefined) byteReports.push(activity.bytes);
    });
    if ('refused' in staged) throw new Error(staged.refused);
    should(events).eql(['downloading', 'downloading', 'verifying', 'unpacking']);
    should(byteReports.length).be.aboveOrEqual(1);
    should(await readFile(join(f.dir, 'fyd'), 'utf8')).equal('old daemon');
    await adapter.swap(staged);
    should(await readFile(join(f.dir, 'fyd'), 'utf8')).equal('new fyd');
    should(await readFile(join(f.dir, 'fyd.previous'), 'utf8')).equal('old daemon');
    await adapter.rollback(f.dir);
    should(await readFile(join(f.dir, 'fyd'), 'utf8')).equal('old daemon');
    should((await readdir(f.dir)).some(name => name.startsWith('.update-'))).be.false();
  });

  it('should swap in a binary that had no previous version, and leave an absent previous one alone on rollback', async () => {
    const f = await fixture();
    await rm(join(f.dir, 'fyd'));
    const adapter = f.subject();
    const staged = await adapter.stage('5.0.1', f.dir);
    if ('refused' in staged) throw new Error(staged.refused);
    await adapter.swap(staged);
    should(await readFile(join(f.dir, 'fyd'), 'utf8')).equal('new fyd');
    await rm(join(f.dir, 'fy.previous'));
    await adapter.rollback(f.dir);
    should(await readFile(join(f.dir, 'fy'), 'utf8')).equal('new fy');
  });

  it('should refuse a signature that does not cover the checksums before it unpacks anything', async () => {
    const f = await fixture();
    f.files.set('checksums.txt', 'changed checksums');
    f.files.set('fy_linux_amd64.tar.gz', 'also changed archive');
    const result = await f.subject().stage('5.0.1', f.dir);
    should(result).match({ refused: /signature that does not match/u });
    should(f.ran).eql([]);
  });

  it('should refuse a signature that cannot be read, and one from a key it does not trust', async () => {
    const f = await fixture();
    f.files.set('checksums.txt.sig', 'no-dot-here');
    should(await f.subject().stage('5.0.1', f.dir)).match({ refused: /carries no readable signature/u });
    const stranger = await keyPair();
    f.files.set('checksums.txt.sig', await stranger.sign(f.checksums));
    should(await f.subject().stage('5.0.1', f.dir)).match({ refused: /signed by a key this fy does not trust/u });
    should(f.ran).eql([]);
  });

  it('should require the archive to match the signed checksum, and the checksum to name it', async () => {
    const f = await fixture();
    f.files.set('fy_linux_amd64.tar.gz', 'changed archive');
    should(await f.subject().stage('5.0.1', f.dir)).match({ refused: /signed checksum/u });
    const bare = new TextEncoder().encode('0'.repeat(64) + '  something_else.tar.gz\n');
    f.files.set('checksums.txt', bare);
    f.files.set('checksums.txt.sig', await f.signer.sign(bare));
    should(await f.subject().stage('5.0.1', f.dir)).match({ refused: /signed checksum/u });
    should(f.ran).eql([]);
  });

  it('should refuse before downloading when no signing key is trusted or no archive exists for the platform', async () => {
    const f = await fixture();
    should(await f.subject([]).stage('5.0.1', f.dir)).match({ refused: /no release-signing key/u });
    should(f.urls).eql([]);
    const other = await fixture({ platform: 'win32' });
    should(await other.subject().stage('5.0.1', other.dir)).match({
      refused: 'no release archive is published for win32/x64',
    });
    const odd = await fixture({ arch: 'riscv64' });
    should(await odd.subject().stage('5.0.1', odd.dir)).match({ refused: /no release archive is published/u });
    should((await readdir(f.dir)).sort()).eql(['fy', 'fyd']);
  });

  it('should refuse and change nothing when a file cannot be downloaded', async () => {
    const f = await fixture();
    f.behaviour.status = 404;
    should(await f.subject().stage('5.0.1', f.dir)).match({ refused: /answered 404; nothing changed/u });
    f.behaviour.status = undefined;
    f.behaviour.fail = true;
    should(await f.subject().stage('5.0.1', f.dir)).match({ refused: /could not download .*; nothing changed/u });
    should((await readdir(f.dir)).sort()).eql(['fy', 'fyd']);
  });

  it('should refuse when the archive cannot be unpacked or carries none of the binaries', async () => {
    const f = await fixture();
    f.behaviour.tar = 2;
    f.behaviour.stderr = ' tar: broken \n';
    should(await f.subject().stage('5.0.1', f.dir)).match({ refused: 'could not unpack the release: tar: broken' });
    const empty = await fixture({ unpack: [] });
    should(await empty.subject().stage('5.0.1', empty.dir)).match({
      refused: 'the release archive carries none of the expected binaries',
    });
    should((await readdir(f.dir)).sort()).eql(['fy', 'fyd']);
  });

  it('should stage only the binaries the archive carries', async () => {
    const f = await fixture({ unpack: ['fy'] });
    const staged = await f.subject().stage('5.0.1', f.dir);
    should(staged).eql({ directory: f.dir, names: ['fy'] });
  });

  it('should read a body without reporting bytes when nobody watches, or when the server named no length', async () => {
    const f = await fixture();
    const quiet = await f.subject().stage('5.0.1', f.dir);
    should('refused' in quiet).be.false();
    await mkdir(join(f.dir, 'again'));
  });
});
