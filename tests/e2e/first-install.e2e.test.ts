import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, it } from 'bun:test';
import should from 'should';
import { type CommandResult, type E2eEnvironment, withE2eEnvironment } from './fixture';

/**
 * The first install, through the shipped `fy` and the REAL compiled `fyd`.
 *
 * `fresh-home-bootstrap.e2e.test.ts` proves the CLI/daemon seam with a stand-in daemon that only
 * bootstraps the state home. This journey is the next step a new owner takes: a real daemon, a
 * machine that already has Claude Code and Codex set up in its home, and the promise that starting
 * the daemon IMPORTS NOTHING until somebody chooses — in the app, with `daemon setup` at a terminal,
 * or with `daemon import <tool>` in a script.
 *
 * WHY THE FIRST BOOT IS THE FIXTURE'S AND NOT `fy daemon start`'s. A daemon with no recorded port
 * chooses the fixed default first, and the CLI's own health probe deliberately ignores `FY_URL` and
 * reads `<FY_HOME>/config/daemon.json`. A `config/daemon.json` written into an EMPTY home is foreign
 * state the daemon refuses, so the only honest way to put this run's leased port where the CLI looks
 * is the order a real owner's machine has after one boot: the first boot runs the compiled daemon
 * with `--config` outside the home (exactly as `relay-browser-pairing` does), which claims the home;
 * the same document then lives at the state home's own config path, and every later start — the one
 * a person types — goes through `fy daemon start` and binds the recorded port, never the default.
 *
 * NOTHING HERE LEAVES LOOPBACK. The document declares the relay discovery carrier switched off, so
 * the daemon never dials the hosted directory; `fy daemon start` hands the daemon only `FY_HOME`,
 * `HOME` and `PATH`, so an environment override could not have done that job.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..');
const NOT_SET_UP = "This machine isn't set up yet.";
const SETUP_NEEDS_TERMINAL = 'asks a few questions, so it needs a terminal';
const PASSWORD_PROMPT = 'Operator password (Enter to skip)';
const EXIT_MARKER = 'FY-E2E-START-EXIT:';

function compiledDaemon(): string {
  const explicit = process.env.FYD_BIN;
  if (explicit !== undefined && explicit !== '') return explicit;
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64-baseline';
  return join(REPOSITORY_ROOT, 'dist', 'bin', `fyd-${platform}-${architecture}`);
}

/**
 * How the document spells the bind. Both are valid to the daemon, which lets a `carriers` bind win
 * over the legacy top-level `host`/`port`; see the carriers test below for why the spelling matters.
 */
type BindSpelling = 'legacy' | 'carriers';

/** A loopback-only document on this run's leased port, with relay discovery explicitly switched off. */
function daemonDocument(port: number, spelling: BindSpelling = 'legacy'): string {
  const relayOff = { kind: 'relay', source: 'discovery', enabled: false };
  const document =
    spelling === 'legacy'
      ? { host: '127.0.0.1', port, carriers: [relayOff] }
      : { carriers: [{ kind: 'bind', host: '127.0.0.1', port }, relayOff] };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * A person's own Claude Code and Codex, where each harness keeps them — inside the TEMP home.
 *
 * Never a copy of a real one: the contents are invented, and the fixture refuses any path that
 * resolves into live state.
 */
async function seedHarnessHomes(environment: E2eEnvironment): Promise<void> {
  const claude = join(environment.paths.home, '.claude');
  const codex = join(environment.paths.home, '.codex');
  await mkdir(join(claude, 'skills', 'e2e-claude-skill'), { recursive: true });
  await mkdir(join(codex, 'skills', 'e2e-codex-skill'), { recursive: true });
  await writeFile(join(claude, 'CLAUDE.md'), '# E2E Claude instructions\n', 'utf8');
  await writeFile(join(claude, 'settings.json'), `${JSON.stringify({ theme: 'dark' })}\n`, 'utf8');
  await writeFile(join(claude, 'skills', 'e2e-claude-skill', 'SKILL.md'), '# claude skill\n', 'utf8');
  await writeFile(join(codex, 'AGENTS.md'), '# E2E Codex instructions\n', 'utf8');
  await writeFile(join(codex, 'config.toml'), 'model = "e2e"\n', 'utf8');
  await writeFile(join(codex, 'skills', 'e2e-codex-skill', 'SKILL.md'), '# codex skill\n', 'utf8');
  // Both tools are "installed": the daemon finds a harness by a PATH lookup, and the fixture's bin
  // directory is first on the PATH every child gets.
  await environment.installFakeHarness('claude');
  await environment.installFakeHarness('codex');
}

/** Every file under the state home, relative, sorted — the "nothing was written" evidence. */
async function listTree(root: string): Promise<readonly string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(relative(root, path));
    }
  };
  await walk(root);
  return found.toSorted();
}

/** What a stopped-then-started home looks like apart from files a running daemon churns by itself. */
function durableState(tree: readonly string[]): readonly string[] {
  return tree.filter(
    path => !/(^|\/)(logs|run|tmp|cache)\//u.test(path) && !/\.(lock|pid|sock|log|wal|shm)$/u.test(path),
  );
}

/**
 * Runs `fy daemon start` on a real terminal — the fixture's tmux server — because the not-set-up line
 * is deliberately said only when a PERSON is watching. Answers the first-password offer with Enter
 * (skip), and returns the screen once the command has exited.
 *
 * THE SHELL OUTLIVES THE COMMAND, and that is load-bearing. The direct supervisor launches the daemon
 * without a new session, so it shares this terminal's session; when the pane's shell exits, the
 * terminal hangs up and SIGHUP kills the daemon `start` just reported ready (reported to the e2e lead
 * as a product bug). So the exit status travels as a marker line and the shell then sleeps; the
 * fixture closes the terminal at dispose, after the journey has stopped the daemon itself.
 */
async function startOnTerminal(
  environment: E2eEnvironment,
  timeoutMs = 200_000,
): Promise<{ code: number; screen: string }> {
  const cli = process.env.CLI_BIN ?? join(REPOSITORY_ROOT, 'dist', 'bin', 'fy-linux-x64-baseline');
  const start = ['env', '-u', 'FY_URL', '-u', 'FY_TOKEN', `FY_DAEMON_BIN=${compiledDaemon()}`, cli, 'daemon', 'start']
    .map(part => `'${part.replaceAll("'", `'"'"'`)}'`)
    .join(' ');
  const launched = await environment.runTmux([
    'new-window',
    '-d',
    '-P',
    '-F',
    '#{pane_id}',
    '-n',
    'fy-daemon-start',
    `${start}; echo "${EXIT_MARKER}$?"; exec sleep 3600`,
  ]);
  if (launched.code !== 0) throw new Error(`could not open a terminal for fy daemon start: ${launched.err}`);
  const pane = launched.out.trim();
  const screen = async (): Promise<string> =>
    (await environment.runTmux(['capture-pane', '-p', '-J', '-S', '-200', '-t', pane])).out;

  let answeredPassword = false;
  const waitForExit = async (until: number): Promise<{ code: number; screen: string } | undefined> => {
    while (Date.now() < until) {
      const shown = await screen();
      const exited = new RegExp(`^${EXIT_MARKER}(\\d+)$`, 'mu').exec(shown);
      if (exited !== null) return { code: Number(exited[1]), screen: shown.slice(0, exited.index) };
      if (!answeredPassword && shown.includes(PASSWORD_PROMPT)) {
        await environment.runTmux(['send-keys', '-t', pane, 'Enter']);
        answeredPassword = true;
      }
      await Bun.sleep(100);
    }
    return undefined;
  };
  const finished = await waitForExit(Date.now() + timeoutMs);
  if (finished !== undefined) return finished;
  // NEVER kill a start that may be holding its lifecycle claim. On a systemd host that claim is
  // host-global (`/tmp/.<uid>.systemd.fyd.service.target.lifecycle.lock`) and is never reclaimed
  // automatically, so a hangup here once blocked every `fy daemon` verb on the machine — this
  // journey's and the owner's. Interrupt it the way a person would, and give it time to let go.
  const stuck = await screen();
  await environment.runTmux(['send-keys', '-t', pane, 'C-c']);
  await waitForExit(Date.now() + 15_000);
  throw new Error(`fy daemon start did not finish on the terminal within ${timeoutMs}ms:\n${stuck}`);
}

/**
 * Stops whatever `fy daemon start` left running, and never lets a cleanup failure hide the journey's.
 *
 * The daemon outlives the `start` that launched it, so a failed journey would otherwise leave a real `fyd`
 * holding this run's port and its state-home lock after the temp tree is gone. `stop` first; then,
 * on Linux, every process whose environment names THIS run's `FY_HOME` is killed — that catches a
 * daemon whose start never got far enough to report a pid, and nothing outside this run can match.
 */
async function stopEverything(environment: E2eEnvironment): Promise<CommandResult | undefined> {
  const stopped = await environment
    .runFy(['daemon', 'stop'], { FY_URL: '', FY_DAEMON_BIN: compiledDaemon() })
    .catch(() => undefined);
  if (process.platform !== 'linux') return stopped;
  const marker = `FY_HOME=${environment.paths.fyHome}\0`;
  for (const entry of await readdir('/proc').catch(() => [] as string[])) {
    if (!/^[0-9]+$/u.test(entry) || Number(entry) === process.pid) continue;
    const environ = await readFile(`/proc/${entry}/environ`, 'utf8').catch(() => '');
    if (!environ.includes(marker)) continue;
    // Only the daemon. The fixture's tmux server inherits this home too and is the fixture's to
    // kill, and a CLI killed while it holds a lifecycle claim would strand that claim host-wide.
    if (!(await readFile(`/proc/${entry}/comm`, 'utf8').catch(() => '')).startsWith('fyd')) continue;
    try {
      process.kill(Number(entry), 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  return stopped;
}

describe('first install with the real daemon', () => {
  it('should import nothing on start, refuse setup without a terminal, and import claude by command', async () => {
    await withE2eEnvironment(async environment => {
      // Arrange — a machine with both tools and their setups, and a state home that has never been run.
      await seedHarnessHomes(environment);
      const outsideConfig = join(environment.paths.root, 'daemon.json');
      await writeFile(outsideConfig, daemonDocument(environment.ports.api), 'utf8');
      const cli = { FY_URL: environment.httpUrl(), FY_DAEMON_BIN: compiledDaemon() };

      // Act 1 — the very first boot of this home, by the real compiled daemon.
      await environment.startDaemon({
        command: [compiledDaemon(), '--config', outsideConfig],
        readyUrl: environment.httpUrl('/v1/health'),
        timeoutMs: 60_000,
      });
      const firstMachine = await environment.runFy(['machine', '--json'], cli);
      const firstRuntimes = await environment.runFy(['runtimes'], cli);
      await environment.stopDaemon(15_000);

      // Assert 1 — booting found both tools and imported neither.
      should(firstMachine.code).equal(0, firstMachine.err);
      const machine = JSON.parse(firstMachine.out) as {
        setUp: boolean;
        format: string;
        runtimeCount: number;
        tools: { harness?: string; label: string; installed: boolean }[];
      };
      should(machine.setUp).be.false();
      should(machine.format).equal('none');
      should(machine.tools.filter(tool => tool.installed)).have.length(2);
      should(firstRuntimes.out + firstRuntimes.err).not.containEql('claude-default');
      should(firstRuntimes.out + firstRuntimes.err).not.containEql('codex-default');

      // Arrange 2 — the document now lives where the daemon and the CLI both look for it.
      await mkdir(join(environment.paths.fyHome, 'config'), { recursive: true });
      await writeFile(
        join(environment.paths.fyHome, 'config', 'daemon.json'),
        await readFile(outsideConfig, 'utf8'),
        'utf8',
      );

      try {
        // Act 2 — a person starts the daemon at a terminal.
        const started = await startOnTerminal(environment);

        // Assert 2 — it started, said the one not-set-up line naming both ways in, and imported nothing.
        const daemonLog = await readFile(join(environment.paths.fyHome, 'logs', 'fyd.log'), 'utf8').catch(
          () => '(no log)',
        );
        should(started.code).equal(0, `${started.screen}\n--- fyd.log ---\n${daemonLog}`);
        should(started.screen).containEql('fyd ready (pid ');
        should(started.screen).containEql(NOT_SET_UP);
        should(started.screen).containEql('fy pair');
        should(started.screen).containEql('fy daemon setup');
        const afterStart = await environment.runFy(['machine', '--json'], { FY_URL: '' });
        should(afterStart.code).equal(0, afterStart.err);
        should((JSON.parse(afterStart.out) as { setUp: boolean }).setUp).be.false();

        // Act 3 — `daemon setup` from a script: no terminal.
        const before = durableState(await listTree(environment.paths.fyHome));
        const setup = await environment.runFy(['daemon', 'setup'], { FY_URL: '' });
        const after = durableState(await listTree(environment.paths.fyHome));

        // Assert 3 — a refusal in words that names the scriptable verb, and nothing written.
        should(setup.code).not.equal(0);
        should(setup.err).containEql(SETUP_NEEDS_TERMINAL);
        should(setup.err).containEql('fy daemon import claude');
        should(setup.err).not.containEql('    at ');
        should(after).eql(before);

        // Act 4 — the scriptable import of ONE tool.
        const imported = await environment.runFy(['daemon', 'import', 'claude'], { FY_URL: '' });
        const runtimes = await environment.runFy(['runtimes'], { FY_URL: '' });
        const machineAfter = await environment.runFy(['machine', '--json'], { FY_URL: '' });

        // Assert 4 — the daemon now reports claude, and only claude, set up.
        should(imported.code).equal(0, `${imported.out}\n${imported.err}`);
        should(runtimes.code).equal(0, runtimes.err);
        should(runtimes.out).containEql('claude-default');
        should(runtimes.out).not.containEql('codex-default');
        const setUp = JSON.parse(machineAfter.out) as { setUp: boolean; runtimeCount: number };
        should(setUp.setUp).be.true();
        should(setUp.runtimeCount).equal(1);
      } finally {
        await stopEverything(environment);
      }
    });
  }, 480_000);

  /**
   * PRODUCT BUG (reported to the e2e lead, severity major): the CLI cannot find a daemon whose bind is
   * spelled as a `carriers` entry.
   *
   * The daemon lets `carriers: [{ kind: 'bind', … }]` win over the legacy top-level `host`/`port`
   * (`packages/daemon/src/lib/runtime/config.ts`, `runtime/carriers.ts`). The CLI's local address
   * resolution reads ONLY the legacy fields (`recordedBindAddress`,
   * `packages/protocol/src/lib/address.ts`), finds no `port`, and falls back to the fixed default. So
   * `fy daemon start` waits 90 seconds and reports "did not become ready" while the log it points at
   * says "ready", and every verb without `FY_URL` reports the daemon stopped — or, worse, reports
   * whatever else is listening on the default port.
   *
   * Driven through the READ-ONLY `daemon status` on purpose: a `start` against this bug blocks for
   * 90 seconds while holding a host-global lifecycle claim, and a harness timeout would strand it.
   */
  it('should find a daemon whose bind is recorded in the carriers spelling', async () => {
    await withE2eEnvironment(async environment => {
      // Arrange — the home is claimed by a first boot, then carries the carriers-form document.
      const outsideConfig = join(environment.paths.root, 'daemon.json');
      await writeFile(outsideConfig, daemonDocument(environment.ports.api, 'carriers'), 'utf8');
      await environment.startDaemon({
        command: [compiledDaemon(), '--config', outsideConfig],
        readyUrl: environment.httpUrl('/v1/health'),
        timeoutMs: 60_000,
      });
      await environment.stopDaemon(15_000);
      await mkdir(join(environment.paths.fyHome, 'config'), { recursive: true });
      await writeFile(
        join(environment.paths.fyHome, 'config', 'daemon.json'),
        daemonDocument(environment.ports.api, 'carriers'),
        'utf8',
      );
      await environment.startDaemon({
        command: [compiledDaemon()],
        readyUrl: environment.httpUrl('/v1/health'),
        timeoutMs: 60_000,
      });

      // Act — no FY_URL: the CLI must find this daemon from the state home's own document.
      const actual = await environment.runFy(['daemon', 'status', '--json'], {
        FY_URL: '',
        FY_DAEMON_BIN: compiledDaemon(),
      });

      // Assert — the daemon bound the carriers port (the readiness URL above proved it), so the
      // CLI must report it serving. On main it reports `stopped`.
      should(actual.code).equal(0, `${actual.out}\n${actual.err}`);
      should((JSON.parse(actual.out) as { reachability: string }).reachability).equal('serving');
    });
  }, 240_000);
});
