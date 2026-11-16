/**
 * Updates' adapters on the real machine: its documents over the kernel's real state port and a temp folder, the
 * latest-release read against a loopback server standing where GitHub would, the install facts read through real
 * links and real child processes (a stand-in `nix`, `dpkg` and `rpm` on a private PATH), and the program search.
 */
import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutableFacts, FetchPort, Log, UpdateHostPort } from '@ferretry/kernel/contract';
import { bunSpawn, state } from '@ferretry/kernel/host';
import { instantFromEpochMs } from '@ferretry/std';
import should from 'should';
import { UPDATES_LATEST, UPDATES_REPORT, type UpdateCheck, type UpdateReport } from '../../contract/index.ts';
import { StateUpdateDocuments } from '../../daemon/adapters/documents.ts';
import { GitHubLatestRelease } from '../../daemon/adapters/github-releases.ts';
import { factCommand, HostInstallFacts } from '../../daemon/adapters/install-facts.ts';
import { processSeams } from '../../daemon/adapters/process-seams.ts';
import type { InstallHost } from '../../daemon/lib/host.ts';
import manifest from '../../manifest.ts';

const folders: string[] = [];
const servers: { stop(force?: boolean): unknown }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })));
});

async function temp(prefix: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), prefix));
  folders.push(folder);
  return folder;
}

function recordingLog(): Log & { readonly warnings: string[] } {
  const warnings: string[] = [];
  const log: Log & { readonly warnings: string[] } = {
    warnings,
    debug: () => undefined,
    info: () => undefined,
    warn: message => {
      warnings.push(message);
    },
    error: () => undefined,
    child: () => log,
  };
  return log;
}

describe('the update documents on disk', () => {
  async function documents() {
    const home = await temp('fy-updates-state-');
    const port = state.createStatePort({
      home,
      pluginId: 'updates',
      files: manifest.data.state,
      fs: state.createNodeHostFs(),
    });
    const log = recordingLog();
    return { home, log, documents: new StateUpdateDocuments(port, log) };
  }

  const found: UpdateCheck = {
    state: 'ok',
    checkedAt: instantFromEpochMs(Date.parse('2026-10-18T08:00:00Z')),
    latest: { version: '4.29.0', url: 'https://github.com/kirinnee/ferretry/releases/tag/v4.29.0' },
  };

  it('should read a never-written home as nothing, and read back the last check it was given', async () => {
    const { documents: store, log } = await documents();

    const before = await store.readLatest();
    await store.writeLatest(found);
    const after = await store.readLatest();

    should(before).be.undefined();
    should(after).deepEqual(found);
    should(log.warnings).deepEqual([]);
  });

  it('should treat a damaged document as never written, and say so once in the log', async () => {
    const { home, documents: store, log } = await documents();
    await store.writeLatest(found);
    await writeFile(join(home, 'state', 'updates', UPDATES_LATEST.path), '{ not json');

    const read = await store.readLatest();

    should(read).be.undefined();
    should(log.warnings).deepEqual(['an update document could not be read; treating it as never written']);
  });

  it('should read the report an update left, and forget it once it has been shown', async () => {
    const { home, documents: store } = await documents();
    const report: UpdateReport = {
      from: '4.28.0',
      target: '4.29.0',
      outcome: 'succeeded',
      message: 'Updated to 4.29.0.',
      finishedAt: instantFromEpochMs(Date.parse('2026-10-18T09:00:00Z')),
    };
    await mkdir(join(home, 'state', 'updates', 'update'), { recursive: true });
    await writeFile(
      join(home, 'state', 'updates', UPDATES_REPORT.path),
      JSON.stringify({ format: UPDATES_REPORT.format, ...report }),
    );

    const first = await store.readReport();
    await store.removeReport();
    const second = await store.readReport();

    should(first).deepEqual(report);
    should(second).be.undefined();
  });
});

describe('the latest release read, with a loopback server where GitHub would be', () => {
  /** The real network stack, with the GitHub API's address sent to this machine. */
  function toLoopback(port: number): FetchPort {
    return {
      request: async (input, init) =>
        await fetch(String(input).replace('https://api.github.com', `http://127.0.0.1:${String(port)}`), init),
    };
  }
  function github(answer: (request: Request) => Response | Promise<Response>) {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: answer });
    servers.push(server);
    return new GitHubLatestRelease('ferretry', toLoopback(server.port ?? 0), {
      userAgent: 'fyd/4.28.0',
      timeoutMs: 1_000,
    });
  }

  it('should ask the release API with a user agent and read the published release', async () => {
    const seen: { path: string; agent: string | null }[] = [];
    const source = github(request => {
      seen.push({ path: new URL(request.url).pathname, agent: request.headers.get('user-agent') });
      return Response.json({
        tag_name: 'v4.29.0',
        html_url: 'https://github.com/kirinnee/ferretry/releases/tag/v4.29.0',
        draft: false,
        prerelease: false,
        published_at: '2026-10-18T08:00:00Z',
      });
    });

    const answer = await source.latest();

    should(answer.kind).equal('ok');
    should(seen).deepEqual([{ path: '/repos/kirinnee/ferretry/releases/latest', agent: 'fyd/4.28.0' }]);
  });

  it('should turn a bad status, a body that is not a release and an unreachable host into one sentence each', async () => {
    const down = github(() => new Response('rate limited', { status: 403 }));
    const odd = github(() => new Response('<html>not json</html>'));
    const draft = github(() => Response.json({ tag_name: 'v9.9.9', html_url: 'https://x.test/', draft: true }));
    const unreachable = new GitHubLatestRelease(
      'ferretry',
      { request: async () => await fetch('http://127.0.0.1:1/') },
      { userAgent: 'fyd/4.28.0', timeoutMs: 1_000 },
    );

    should(await down.latest()).deepEqual({ kind: 'failed', reason: 'GitHub answered 403' });
    should(await odd.latest()).deepEqual({ kind: 'failed', reason: 'GitHub did not name a published release' });
    should(await draft.latest()).deepEqual({ kind: 'failed', reason: 'GitHub did not name a published release' });
    should(await unreachable.latest()).deepEqual({ kind: 'failed', reason: 'could not reach GitHub' });
  });
});

describe('the install facts, from real links and real programs', () => {
  const STORE = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-ferretry-4.28.0';

  /** A private PATH holding these scripts (by name), then the system's own tools. */
  async function programs(scripts: Readonly<Record<string, string>>): Promise<string> {
    const bin = await temp('fy-updates-bin-');
    for (const [name, body] of Object.entries(scripts)) {
      await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
      await chmod(join(bin, name), 0o755);
    }
    return `${bin}:/usr/bin:/bin`;
  }

  function hostFor(
    executable: Partial<ExecutableFacts>,
    options: { readonly home: string; readonly which?: (name: string) => string | undefined },
  ): InstallHost {
    const facts: ExecutableFacts = {
      argv0: '/usr/bin/fyd',
      execPath: '/usr/bin/fyd',
      resolvedExecPath: '/usr/bin/fyd',
      main: '/$bunfs/root/fyd',
      workingDirectory: '/work',
      platform: 'linux',
      ...executable,
    };
    const port: UpdateHostPort = {
      release: '4.28.0',
      compiled: true,
      checks: true,
      executable: async () => facts,
      launchUpdate: async () => ({ kind: 'started' }),
    };
    return { port, product: 'ferretry', homeDirectory: options.home, which: options.which ?? (() => undefined) };
  }

  it('should name the nix profile element holding the daemon, following the launched link with the real readlink', async () => {
    const home = await temp('fy-updates-home-');
    await mkdir(join(home, '.nix-profile', 'bin'), { recursive: true });
    const launched = join(home, '.nix-profile', 'bin', 'fyd');
    await symlink(`${STORE}/bin/fyd`, launched);
    const path = await programs({
      nix: `echo '{"version":3,"elements":{"ferretry":{"storePaths":["${STORE}"]}}}'`,
    });
    const facts = await new HostInstallFacts(
      hostFor({ argv0: launched, execPath: `${STORE}/bin/fyd`, resolvedExecPath: `${STORE}/bin/fyd` }, { home }),
      factCommand(bunSpawn({ PATH: path })),
    ).facts();

    should(facts).containDeep({ launchedPath: launched, nixProfileElement: 'ferretry', platform: 'linux' });
  });

  it('should answer no element when nix is missing, fails or prints something else', async () => {
    const home = await temp('fy-updates-home-');
    for (const nix of [undefined, 'exit 3', 'echo not json']) {
      const path = await programs(nix === undefined ? {} : { nix });
      const facts = await new HostInstallFacts(
        hostFor({ resolvedExecPath: `${STORE}/bin/fyd` }, { home }),
        factCommand(bunSpawn({ PATH: path })),
      ).facts();

      should(facts.nixProfileElement).be.undefined();
    }
  });

  it('should find the system package that owns the executable: apt, then dnf or yum', async () => {
    const home = await temp('fy-updates-home-');
    const apt = await programs({ dpkg: 'exit 0' });
    const rpm = await programs({ dpkg: 'exit 1', rpm: 'exit 0' });
    const neither = await programs({ dpkg: 'exit 1', rpm: 'exit 1' });
    const factsOn = async (path: string, which?: (name: string) => string | undefined) =>
      await new HostInstallFacts(
        hostFor({}, { home, ...(which === undefined ? {} : { which }) }),
        factCommand(bunSpawn({ PATH: path })),
      ).facts();

    should((await factsOn(apt)).systemPackage).equal('apt');
    should((await factsOn(rpm, name => (name === 'dnf' ? '/usr/bin/dnf' : undefined))).systemPackage).equal('dnf');
    should((await factsOn(rpm)).systemPackage).equal('yum');
    should((await factsOn(neither)).systemPackage).be.undefined();
  });

  it('should ask no package manager on a platform that has none', async () => {
    const home = await temp('fy-updates-home-');
    const facts = await new HostInstallFacts(
      hostFor({ platform: 'darwin' }, { home }),
      factCommand(bunSpawn({ PATH: await programs({ dpkg: 'exit 0' }) })),
    ).facts();

    should(facts.systemPackage).be.undefined();
  });

  it('should work out the launched path from how the daemon was named', async () => {
    const home = await temp('fy-updates-home-');
    const run = factCommand(bunSpawn({ PATH: '/usr/bin:/bin' }));
    const launchedFor = async (executable: Partial<ExecutableFacts>, which?: (name: string) => string | undefined) =>
      (
        await new HostInstallFacts(
          hostFor(executable, { home, ...(which === undefined ? {} : { which }) }),
          run,
        ).facts()
      ).launchedPath;

    should(await launchedFor({ argv0: '/opt/ferretry/bin/fyd' })).equal('/opt/ferretry/bin/fyd');
    should(await launchedFor({ argv0: './bin/../fyd', workingDirectory: '/work/app' })).equal('/work/app/fyd');
    should(await launchedFor({ argv0: 'fyd' }, name => (name === 'fyd' ? '/usr/local/bin/fyd' : undefined))).equal(
      '/usr/local/bin/fyd',
    );
    should(await launchedFor({ argv0: 'fyd', execPath: '/opt/fyd' })).equal('/opt/fyd');
  });

  it('should run a program with its exit code and output, and say nothing when it is not installed', async () => {
    const path = await programs({ talks: 'echo hello; exit 4' });
    const run = factCommand(bunSpawn({ PATH: path }));

    should(await run(['talks'])).deepEqual({ code: 4, stdout: 'hello\n' });
    should(await run(['no-such-program-anywhere'])).be.undefined();
  });
});

describe('the program search', () => {
  it('should find a program on the search path, and report an absent one as nothing', () => {
    const seams = processSeams('/home/someone');

    should(seams.homeDirectory).equal('/home/someone');
    should(seams.which('sh')).be.a.String();
    should(seams.which('no-such-program-anywhere')).be.undefined();
  });
});
