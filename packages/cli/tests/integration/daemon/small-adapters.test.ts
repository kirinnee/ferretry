import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import should from 'should';
import { RunRecordDaemonHealth } from '../../../src/adapters/daemon/health.ts';
import { privateRuntimeDirectory } from '../../../src/adapters/daemon/runtime-directory.ts';
import { TmuxSessionTerminalServer } from '../../../src/adapters/daemon/session-terminals.ts';
import { sleepUnlessAborted } from '../../../src/adapters/daemon/sleep.ts';
import { homeMarker, serviceRefusal } from '../../../src/adapters/daemon/state-home-marker.ts';
import { DaemonTokenFileError, readAdminToken } from '../../../src/adapters/daemon/token-file.ts';
import { terminalPrompt } from '../../../src/adapters/terminal/prompt.ts';
import { HEALTH, standInDaemon } from '../support/stand-in-daemon.ts';

const dirs: string[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fy-small-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async dir => await rm(dir, { recursive: true, force: true })));
});

describe('a pause the caller can leave', () => {
  it('should wait the whole time when nobody can abort it, and when nobody does', async () => {
    const started = Date.now();
    await sleepUnlessAborted(30);
    await sleepUnlessAborted(30, new AbortController().signal);
    should(Date.now() - started).be.aboveOrEqual(55);
  });

  it('should end at once when the signal is already aborted, or aborts during the wait', async () => {
    const aborted = new AbortController();
    aborted.abort();
    await sleepUnlessAborted(60_000, aborted.signal);
    const later = new AbortController();
    const waiting = sleepUnlessAborted(60_000, later.signal);
    later.abort();
    await waiting;
  });
});

describe('the private runtime directory', () => {
  const me = process.getuid?.() ?? 0;

  it('should accept an absolute directory this user owns and nobody else can enter', async () => {
    const dir = await temp();
    await chmod(dir, 0o700);
    should(privateRuntimeDirectory(dir, me)).equal(dir);
  });

  it('should answer nothing for an unset, relative, shared, foreign, missing or non-directory candidate', async () => {
    const dir = await temp();
    await chmod(dir, 0o770);
    const file = join(dir, 'file');
    await writeFile(file, '');
    should(privateRuntimeDirectory(undefined, me)).be.undefined();
    should(privateRuntimeDirectory('relative/dir', me)).be.undefined();
    should(privateRuntimeDirectory(dir, me)).be.undefined();
    await chmod(dir, 0o700);
    should(privateRuntimeDirectory(dir, me + 1)).be.undefined();
    should(privateRuntimeDirectory(join(dir, 'missing'), me)).be.undefined();
    should(privateRuntimeDirectory(file, me)).be.undefined();
  });

  it('should follow a link to the directory the variable points through', async () => {
    const dir = await temp();
    await chmod(dir, 0o700);
    const link = join(await temp(), 'run');
    await symlink(dir, link);
    should(privateRuntimeDirectory(link, me)).equal(link);
  });
});

describe('the marker of a state home', () => {
  it('should call a missing home absent, an empty one empty, and one with a format-1 marker claimed', async () => {
    const dir = await temp();
    const empty = join(dir, 'empty');
    const claimed = join(dir, 'claimed');
    await mkdir(empty);
    await mkdir(claimed);
    await writeFile(
      join(claimed, 'home.json'),
      JSON.stringify({ format: 1, createdBy: 'fyd 5.0.0', createdAt: '2026-11-06T09:00:00.000Z' }),
    );
    should(await homeMarker.inspect(join(dir, 'absent'))).equal('absent');
    should(await homeMarker.inspect(empty)).equal('empty');
    should(await homeMarker.inspect(claimed)).equal('claimed');
  });

  it('should call anything else unclaimed: a marker of another shape, a marker that is not JSON, other files, a file', async () => {
    const dir = await temp();
    const other = join(dir, 'other');
    const broken = join(dir, 'broken');
    const stuff = join(dir, 'stuff');
    await mkdir(other);
    await mkdir(broken);
    await mkdir(stuff);
    await writeFile(join(other, 'home.json'), JSON.stringify({ format: 2 }));
    await writeFile(join(broken, 'home.json'), '{nope');
    await writeFile(join(stuff, 'notes.txt'), 'mine');
    const file = join(dir, 'a-file');
    await writeFile(file, 'x');
    should(await homeMarker.inspect(other)).equal('unclaimed');
    should(await homeMarker.inspect(broken)).equal('unclaimed');
    should(await homeMarker.inspect(stuff)).equal('unclaimed');
    should(await homeMarker.inspect(file)).equal('unclaimed');
  });
});

/** What the service definitions say of a folder that is not a Ferretry 5 home: ours, or the carry-over sentence. */
describe('why a service definition may not be written for a home', () => {
  it('should say nothing of a Ferretry 5 home', async () => {
    const dir = await temp();
    await writeFile(
      join(dir, 'home.json'),
      JSON.stringify({ format: 1, createdBy: 'fyd 5.0.0', createdAt: '2026-11-06T09:00:00.000Z' }),
    );
    should(await serviceRefusal(dir)).be.undefined();
  });

  it('should say the daemon creates a home that is missing or empty, and only then', async () => {
    const dir = await temp();
    const empty = join(dir, 'empty');
    await mkdir(empty);
    for (const home of [join(dir, 'absent'), empty])
      should(await serviceRefusal(home)).equal(
        `${home} is not a Ferretry home; the daemon creates it on its first start`,
      );
  });

  it('should give a folder with content and no home.json the carry-over sentence and the way back to 4.291.9', async () => {
    const dir = await temp();
    await writeFile(join(dir, 'layout-version'), '2\n');
    const said = await serviceRefusal(dir);
    should(said).containEql(`${dir} is not empty and has no home.json`);
    should(said).containEql('docs/migration/v4-to-v5-prompt.md').and.containEql('reinstall 4.291.9');
    should(said).not.containEql('creates it on its first start');
  });

  it("should give a home.json of another format or shape the kernel's own sentence for it", async () => {
    const dir = await temp();
    const newer = join(dir, 'newer');
    const broken = join(dir, 'broken');
    await mkdir(newer);
    await mkdir(broken);
    await writeFile(join(newer, 'home.json'), JSON.stringify({ format: 2 }));
    await writeFile(join(broken, 'home.json'), '{nope');
    should(await serviceRefusal(newer)).containEql('was written by a newer Ferretry');
    should(await serviceRefusal(broken))
      .be.a.String()
      .and.not.containEql('creates it on its first start');
  });
});

describe('ending the daemon’s private terminal server', () => {
  const outcome = (code: number, stderr = '') => ({ code, stdout: '', stderr });
  const serverFor = (result: ReturnType<typeof outcome>) => {
    const asked: (readonly string[])[] = [];
    const server = new TmuxSessionTerminalServer(
      {
        run: async argv => {
          asked.push(argv);
          return result;
        },
      },
      'tmux-under-test',
    );
    return { server, asked };
  };

  it('should ask nothing when no socket was ever there', async () => {
    const dir = await temp();
    const { server, asked } = serverFor(outcome(0));
    should(await server.end(join(dir, 'no-socket'))).eql({ kind: 'none' });
    should(asked).eql([]);
  });

  it('should end the server on that socket alone', async () => {
    const socket = join(await temp(), 'tmux.sock');
    await writeFile(socket, '');
    const { server, asked } = serverFor(outcome(0));
    should(await server.end(socket)).eql({ kind: 'ended' });
    should(asked).eql([['tmux-under-test', '-S', socket, 'kill-server']]);
  });

  it('should say tmux is missing, treat a dead server as nothing to end, and report any other refusal', async () => {
    const socket = join(await temp(), 'tmux.sock');
    await writeFile(socket, '');
    should(await serverFor(outcome(127)).server.end(socket)).eql({
      kind: 'failed',
      reason: 'tmux-under-test was not found on PATH',
    });
    for (const said of [
      'no server running on /x',
      'error connecting to /x (No such file or directory)',
      'Connection refused',
    ]) {
      should(await serverFor(outcome(1, said)).server.end(socket)).eql({ kind: 'none' });
    }
    should(await serverFor(outcome(1, 'unexpected failure\n')).server.end(socket)).eql({
      kind: 'failed',
      reason: 'unexpected failure',
    });
    should(await serverFor(outcome(3)).server.end(socket)).eql({ kind: 'failed', reason: 'tmux-under-test exited 3' });
  });
});

describe('asking the daemon who serves', () => {
  const serving = { protocol: 7, version: '5.0.0', pid: 4242 };

  it('should read the process and build that answer, whatever protocol it speaks', async () => {
    const daemon = standInDaemon(() => Response.json({ ...serving, extra: 'ignored' }));
    const health = new RunRecordDaemonHealth(async () => daemon.url);
    should(await health.probe()).eql(serving);
    should(daemon.seen[0]).match({ method: 'GET', path: '/healthz' });
  });

  it('should answer nothing for an error, an answer that is not a daemon’s, a pid it cannot be, or no answer', async () => {
    const booting = standInDaemon(() => new Response('', { status: 503 }));
    const notJson = standInDaemon(() => new Response('hello'));
    const wrongShape = standInDaemon(() => Response.json(HEALTH));
    const lowPid = standInDaemon(() => Response.json({ ...serving, pid: 1 }));
    for (const daemon of [booting, notJson, wrongShape, lowPid]) {
      should(await new RunRecordDaemonHealth(async () => daemon.url).probe()).be.undefined();
    }
    const gone = standInDaemon(() => new Response(''));
    const url = gone.url;
    gone.server.stop(true);
    should(await new RunRecordDaemonHealth(async () => url, undefined, 500).probe()).be.undefined();
    should(
      await new RunRecordDaemonHealth(async () => {
        throw new Error('no run record');
      }).probe(),
    ).be.undefined();
  });

  it('should ask again for the address every time, so a daemon that moved port is found', async () => {
    const first = standInDaemon(() => new Response('', { status: 503 }));
    const second = standInDaemon(() => Response.json(serving));
    let url = first.url;
    const health = new RunRecordDaemonHealth(async () => url);
    should(await health.probe()).be.undefined();
    url = second.url;
    should(await health.probe()).eql(serving);
  });
});

describe('reading the admin token when the file system misbehaves', () => {
  const failing = (parts: { stat?: Error; read?: Error; mode?: number }) => ({
    stat: async () => {
      if (parts.stat !== undefined) throw parts.stat;
      return { isFile: () => true, mode: parts.mode ?? 0o600 };
    },
    readFile: async () => {
      if (parts.read !== undefined) throw parts.read;
      return 'token';
    },
  });

  it('should say a file it cannot inspect, or cannot read, by the reason and never by its contents', async () => {
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const inspect = await readAdminToken('/x/token', failing({ stat: denied })).catch((error: unknown) => error);
    const read = await readAdminToken('/x/token', failing({ read: new Error('io failure') })).catch(
      (error: unknown) => error,
    );
    should(inspect).be.instanceOf(DaemonTokenFileError);
    should((inspect as Error).message).equal(
      'FY_TOKEN is not set and the daemon token cannot be inspected at /x/token: permission denied',
    );
    should((read as Error).message).equal(
      'FY_TOKEN is not set and the daemon token cannot be read at /x/token: io failure',
    );
  });
});

describe('asking the person at the terminal', () => {
  it('should print the question on stderr and return the line typed, leaving stdout alone', async () => {
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    const written: string[] = [];
    stderr.on('data', chunk => written.push(String(chunk)));
    const realIn = Object.getOwnPropertyDescriptor(process, 'stdin');
    const realErr = Object.getOwnPropertyDescriptor(process, 'stderr');
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    Object.defineProperty(process, 'stderr', { value: stderr, configurable: true });
    try {
      const asking = terminalPrompt.ask('Stop the daemon?');
      stdin.write('yes\n');
      should(await asking).equal('yes');
    } finally {
      if (realIn !== undefined) Object.defineProperty(process, 'stdin', realIn);
      if (realErr !== undefined) Object.defineProperty(process, 'stderr', realErr);
    }
    should(written.join('')).containEql('Stop the daemon? ');
  });
});
