/**
 * THE SELF-CHECK OF THE PIPELINE'S ISOLATION (secure-clip-1 fix2, R1): no Chrome, no network. It proves the wrapper the
 * pipeline test launches under really binds a child's `HOME`/`XDG_*` to the temporary home whatever it was handed, and puts
 * the egress block on a Chrome and on nothing else. The pipeline test is run only after this passes.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import type { ChildHandle, SpawnBytesResult, SpawnPort, SpawnResult } from '../../../contract/index.ts';
import { bunSpawn } from '../../../host/index.ts';
import {
  BOUND_NAMES,
  egressArguments,
  homeEnvironment,
  isolatedSpawn,
  type Launch,
  loopbackFetch,
  writeFontConfiguration,
  XDG_DIRECTORIES,
} from './secure-copy-isolation.ts';

let home = '';
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'ferretry-isolation-self-check-'));
});
afterAll(async () => {
  if (home !== '') await rm(home, { recursive: true, force: true });
});

/** A port that records what it was asked and starts nothing. */
const recording = (): { port: SpawnPort; seen: { program: string; args: readonly string[]; env: unknown }[] } => {
  const seen: { program: string; args: readonly string[]; env: unknown }[] = [];
  const note = (program: string, args: readonly string[], options?: { env?: unknown }) =>
    void seen.push({ program, args, env: options?.env });
  return {
    seen,
    port: {
      run: async (program, args, options) => {
        note(program, args, options);
        return { exitCode: 0, signal: null, stdout: '', stderr: '' } satisfies SpawnResult;
      },
      runBytes: async (program, args, options) => {
        note(program, args, options);
        return {
          exitCode: 0,
          stdout: new Uint8Array(),
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
        } satisfies SpawnBytesResult;
      },
      start: (program, args, options) => {
        note(program, args, options);
        return {} as ChildHandle;
      },
    },
  };
};

const HOSTILE = {
  HOME: '/home/someone-real',
  XDG_CONFIG_HOME: '/home/someone-real/.config',
  XDG_CACHE_HOME: '/home/someone-real/.cache',
  XDG_DATA_HOME: '/home/someone-real/.local/share',
  XDG_STATE_HOME: '/home/someone-real/.local/state',
  XDG_RUNTIME_DIR: '/run/user/1000',
  TMPDIR: '/var/tmp',
  PATH: '/usr/bin',
};

describe('the pipeline’s isolation (self-check)', () => {
  it('should give the temporary home its own font configuration, naming no directory of any real home', async () => {
    const file = await writeFontConfiguration(home);
    const text = await readFile(file, 'utf8');

    should(file.startsWith(`${home}/`)).equal(true);
    should(text).containEql(`<cachedir>${join(home, '.cache', 'fontconfig')}</cachedir>`);
    const directories = [...text.matchAll(/<dir>([^<]+)<\/dir>/gu)].map(match => match[1] as string);
    for (const directory of directories) {
      should(directory.startsWith('/')).equal(true);
      should(directory).not.match(/^\/(?:home|Users|root)\//u);
    }
  });

  it('should answer a loopback fetch and refuse any other host before anything is sent', async () => {
    const asked: string[] = [];
    const guarded = loopbackFetch({
      request: async url => {
        asked.push(String(url));
        return new Response('ok');
      },
    });

    should(await (await guarded.request('http://127.0.0.1:41999/x')).text()).equal('ok');
    should(await (await guarded.request(new URL('http://localhost:41999/y'))).text()).equal('ok');
    await should(guarded.request('http://203.0.113.7/exfil')).be.rejectedWith(/external request/u);
    await should(guarded.request('https://example.com/')).be.rejectedWith(/external request/u);
    should(asked).eql(['http://127.0.0.1:41999/x', 'http://localhost:41999/y']);
  });

  it('should bind HOME, every XDG directory and TMPDIR under the temporary home, and nothing outside it', () => {
    const bound = homeEnvironment(home);

    should(Object.keys(bound).sort()).eql([...BOUND_NAMES].sort());
    for (const name of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR'])
      should(Object.keys(XDG_DIRECTORIES)).containEql(name);
    for (const value of Object.values(bound)) should(value === home || value.startsWith(`${home}/`)).equal(true);
  });

  it('should override a hostile real HOME and XDG environment on start, run and runBytes, keeping the rest', async () => {
    const launches: Launch[] = [];
    const { port, seen } = recording();
    const wrapped = isolatedSpawn(port, { home, proxy: 'http://127.0.0.1:41999', launches });

    wrapped.start('/usr/bin/worker', ['--serve'], { env: HOSTILE });
    await wrapped.run('/usr/bin/worker', [], { env: HOSTILE });
    await wrapped.runBytes('/usr/bin/worker', [], { env: HOSTILE });
    wrapped.start('/usr/bin/worker', [], undefined);

    should(seen).have.length(4);
    for (const call of seen) {
      const env = call.env as Record<string, string>;
      should(env.HOME).equal(home);
      for (const name of BOUND_NAMES) should(env[name]?.startsWith(home)).equal(true);
    }
    should((seen[0]?.env as Record<string, string> | undefined)?.PATH).equal('/usr/bin');
    should(launches.map(launch => launch.env.HOME)).eql([home, home, home, home]);
  });

  it('should hand a REAL child the temporary home, not the one it was given', async () => {
    const launches: Launch[] = [];
    const real = bunSpawn({ PATH: process.env.PATH ?? '/usr/bin:/bin' });
    const wrapped = isolatedSpawn(real, { home, proxy: 'http://127.0.0.1:41999', launches });

    const ran = await wrapped.run(
      '/bin/sh',
      ['-c', 'printf "%s|%s|%s" "$HOME" "$XDG_CONFIG_HOME" "$XDG_RUNTIME_DIR"'],
      { env: HOSTILE },
    );

    should(ran.stdout).equal(`${home}|${join(home, '.config')}|${join(home, 'run')}`);
    should(ran.stdout).not.containEql('someone-real');
  });

  it('should add the egress block to a Chrome after its own switches, and to nothing else', async () => {
    const launches: Launch[] = [];
    const { port, seen } = recording();
    const proxy = 'http://127.0.0.1:41999';
    const wrapped = isolatedSpawn(port, { home, proxy, launches });

    wrapped.start('/usr/bin/google-chrome', [`--user-data-dir=${join(home, 'profile')}`, '--headless=new'], {});
    wrapped.start('/usr/bin/bun', ['worker.ts'], {});

    should(seen[0]?.args.slice(-3)).eql([...egressArguments(proxy)]);
    should(seen[0]?.args[0]).startWith('--user-data-dir=');
    should(seen[1]?.args).eql(['worker.ts']);
  });

  it('should send Chrome’s traffic to the loopback tripwire and resolve nothing but loopback', () => {
    const switches = egressArguments('http://127.0.0.1:41999');

    should(switches).containEql('--proxy-server=http://127.0.0.1:41999');
    should(switches.join(' ')).containEql('MAP * ~NOTFOUND');
    should(switches.join(' ')).containEql('EXCLUDE 127.0.0.1');
    should(switches.join(' ')).containEql('EXCLUDE localhost');
    // Only loopback is bypassed: no external name is exempt from the block.
    should(switches.find(each => each.startsWith('--proxy-bypass-list='))).equal(
      '--proxy-bypass-list=127.0.0.1;localhost',
    );
    should(switches.join(' ')).not.match(/7431|7458/u);
  });
});
