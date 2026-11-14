import { appendFile, chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * A sandbox for `migrate.sh`: a temp HOME, a fake v4 home, a throwaway git checkout holding a copy of the script at a
 * released tag, and FAKE `fy`, `fyd`, `tmux`, `brew`, `nix`, `xattr`, `sleep`, `ps` and `bun` on PATH. Every fake
 * records its calls (and the PATH / FY_URL it saw) under `fake/`, answers from scripted rules, and exits 99 with an
 * `UNSCRIPTED` line for a call nobody scripted, so a test never passes by accident. Nothing here touches the real
 * machine's fy, fyd, brew, nix or tmux, and no real credential exists anywhere in it.
 */

// MIGRATE_SH_UNDER_TEST points a run at another copy of the script (to prove a new test fails on the old one).
const SCRIPT = process.env.MIGRATE_SH_UNDER_TEST ?? join(import.meta.dir, '..', '..', 'migrate.sh');

/** A value that must never appear in anything the script prints or writes: it sits in a fake sealed store and in a trap field. */
export const SECRET_VALUE = 'SUPERSECRET-VALUE-do-not-print';

export interface Rule {
  /** A bash `case` glob over the fake's arguments joined by spaces. First match wins. */
  readonly match: string;
  readonly out?: string;
  readonly err?: string;
  readonly code?: number;
  /** Bash run before the output; it may print too. */
  readonly run?: string;
}

const quote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

function fakeScript(name: string, rules: readonly Rule[]): string {
  const arms = rules
    .map(rule =>
      [
        `  ${rule.match.replaceAll(' ', '\\ ')})`,
        rule.run === undefined ? '' : `    ${rule.run}`,
        rule.out === undefined ? '' : `    printf '%s\\n' ${quote(rule.out)}`,
        rule.err === undefined ? '' : `    printf '%s\\n' ${quote(rule.err)} >&2`,
        `    exit ${rule.code ?? 0} ;;`,
      ]
        .filter(line => line !== '')
        .join('\n'),
    )
    .join('\n');
  return `#!/usr/bin/env bash
D="\${FAKE_DIR:?}"
printf '%s %s\\n' ${quote(name)} "$*" >> "$D/calls.log"
printf '%s|%s|PATH=%s|FY_URL=%s|FY_HOME=%s|FY_PORT=%s\\n' ${quote(name)} "$*" "$PATH" "\${FY_URL-<unset>}" "\${FY_HOME-<unset>}" "\${FY_PORT-<unset>}" >> "$D/env.log"
case "$*" in
${arms}
esac
printf '%s %s\\n' ${quote(name)} "$*" >> "$D/unscripted.log"
exit 99
`;
}

/**
 * A "running daemon" in a fake home is what the script reads: `run/daemon.json` naming a LIVE process id. These shell
 * snippets (for a fake `fy daemon start|stop`) start / kill a short-lived `sleep` fixture by PID only.
 */
export const DAEMON_UP_SH =
  'mkdir -p "$FAKE_H/run"; command -p sleep 300 >/dev/null 2>&1 </dev/null & p=$!; echo "$p" >> "$D/fixture.pids"; ' +
  'printf \'{"format":1,"socket":"%s/run/fyd.sock","host":"127.0.0.1","port":9,"pid":%s,"version":"5.0.0"}\\n\' "$FAKE_H" "$p" > "$FAKE_H/run/daemon.json"';
export const DAEMON_DOWN_SH =
  'if [ -f "$D/fixture.pids" ]; then while read -r p; do kill "$p" 2>/dev/null; done < "$D/fixture.pids"; : > "$D/fixture.pids"; fi; rm -f "$FAKE_H/run/daemon.json"';

const BOARD_EMPTY = '{"cards":[],"nextCursor":null}';

export const V4_PS = JSON.stringify([
  { config: { id: 'f1', teammate: 'ashlie', name: 'Review Migration Prompt Fixes' }, state: { status: 'working' } },
  { config: { id: 'f2', teammate: 'bob', name: 'Child task', parent: 'f1' }, state: { status: 'stopped' } },
]);
export const V5_PS = JSON.stringify([
  { id: 'f1', name: 'ashlie', title: 'Review Migration Prompt Fixes' },
  { id: 'f2', name: 'bob', title: 'Child task', parent: 'f1' },
]);
const SECRET_LS = JSON.stringify({
  health: 'ready',
  secrets: [{ name: 'API_KEY', value: SECRET_VALUE, createdAt: 'x', updatedAt: 'x' }],
});
const BOARD_OPEN = '{"cards":[{"id":"C1","laneId":"todo","title":"t"}],"nextCursor":null}';

export interface Sandbox {
  readonly root: string;
  readonly repo: string;
  readonly home: string;
  readonly v4home: string;
  readonly fakeDir: string;
  readonly notes: string;
  readonly v5bin: string;
  /** Replace one fake's rules (rules before the sandbox defaults win). */
  fake(name: string, rules: readonly Rule[]): Promise<void>;
  /** Write a state file the fakes read (`fake/<name>`). */
  state(name: string, content: string): Promise<void>;
  readState(name: string): Promise<string>;
  run(
    phase: string,
    args?: readonly string[],
    env?: Readonly<Record<string, string | undefined>>,
  ): Promise<{ code: number; out: string; err: string; all: string }>;
  calls(): Promise<string[]>;
  envLog(): Promise<string[]>;
  unscripted(): Promise<string[]>;
  notesText(): Promise<string>;
  cleanup(): Promise<void>;
  /**
   * Start a live fixture "daemon" (a short-lived child, killed by PID only) and record it in the home's
   * `run/daemon.json`. `comm` is the kernel name of the process: `sleep` (default) or `bun`.
   */
  daemonUp(options?: { readonly comm?: 'sleep' | 'bun'; readonly home?: string }): Promise<number>;
  /** Kill every fixture daemon this sandbox started and remove the record. */
  daemonDown(): Promise<void>;
  /** Every regular file's mtime and path under a directory, as one string: "nothing changed" is a string comparison. */
  treeSignature(dir: string): Promise<string>;
  /** Everything under HOME, v4home siblings and the notes folder, as one string (for "no secret anywhere"). */
  everything(): Promise<string>;
}

const read = async (path: string): Promise<string> => {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
};

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'pipe' });
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(' ')}: ${await new Response(proc.stderr).text()}`);
}

export interface SandboxOptions {
  /** Casks `brew list --cask` prints, one per line. Default: the v4 cask. */
  readonly casks?: string;
  readonly tag?: string | null;
  /** The v4 home's directory name (default `v4home`; `.ferretry` makes it the default home). */
  readonly homeName?: string;
  readonly panes?: boolean;
}

export async function makeSandbox(options: SandboxOptions = {}): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), 'migrate-sh-'));
  const home = join(root, 'home');
  const v4home = join(home, options.homeName ?? 'v4home');
  const fakeDir = join(root, 'fake');
  const fakeBin = join(root, 'fakebin');
  const repo = join(root, 'repo');
  const v5bin = join(root, 'v5bin');
  for (const dir of [home, fakeDir, fakeBin, join(repo, 'migration', 'v4-to-v5'), v5bin])
    await mkdir(dir, { recursive: true });

  // The checkout: the script itself in a git repository at a released tag.
  await cp(SCRIPT, join(repo, 'migration', 'v4-to-v5', 'migrate.sh'));
  await cp(join(dirname(SCRIPT), 'left-behind.txt'), join(repo, 'migration', 'v4-to-v5', 'left-behind.txt'));
  await writeFile(join(repo, '.gitignore'), 'node_modules\n');
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'add', '-A');
  await git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  if (options.tag !== null) await git(repo, 'tag', options.tag ?? 'v5.0.0');

  // A v4 home: layout 2, one running ferret's pane file, two logins, a sealed store that must never be read.
  await mkdir(join(v4home, 'state', 'sessions', 'f1'), { recursive: true });
  await mkdir(join(v4home, 'state', 'sessions', 'f2'), { recursive: true });
  await mkdir(join(v4home, 'config', 'logins'), { recursive: true });
  await writeFile(join(v4home, 'layout-version'), '2\n');
  if (options.panes !== false) {
    await writeFile(
      join(v4home, 'state', 'sessions', 'f1', 'terminal-pane.json'),
      JSON.stringify({ sessionId: 'f1', tmuxSession: 'fy-f1', paneId: '%1' }),
    );
  }
  await writeFile(join(v4home, 'config', 'logins', 'alpha.yaml'), 'harness: claude\n');
  await writeFile(join(v4home, 'config', 'logins', 'beta.yaml'), 'harness: codex\n');
  await writeFile(join(v4home, 'state', 'secrets.json'), `{"sealed":"${SECRET_VALUE}"}\n`);
  await writeFile(join(v4home, 'state', 'secrets.key'), `${SECRET_VALUE}\n`);
  // tmux.sock must be a real socket for `[ -S ]`.
  const listener =
    options.panes === false ? undefined : Bun.listen({ unix: join(v4home, 'tmux.sock'), socket: { data() {} } });

  const fixtures = new Set<number>();
  const killFixtures = async (): Promise<void> => {
    for (const pid of fixtures) {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
    fixtures.clear();
    // The fake `fy daemon start` fixtures are listed by the shell; kill those by PID too.
    for (const line of (await read(join(fakeDir, 'fixture.pids'))).split('\n').filter(Boolean)) {
      try {
        process.kill(Number(line));
      } catch {
        // already gone
      }
    }
  };

  const sandbox: Sandbox = {
    root,
    repo,
    home,
    v4home,
    fakeDir,
    notes: join(home, 'run.notes'),
    v5bin,
    async fake(name, rules) {
      const path = join(fakeBin, name);
      await writeFile(path, fakeScript(name, rules));
      await chmod(path, 0o755);
    },
    async state(name, content) {
      await writeFile(join(fakeDir, name), content);
    },
    readState: name => read(join(fakeDir, name)),
    async run(phase, args = [], env = {}) {
      const baseEnv: Record<string, string> = {
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        HOME: home,
        FY_HOME: v4home,
        FAKE_DIR: fakeDir,
        FAKE_H: v4home,
        MIGRATE_STAMP: '2026-11-13-1200',
        MIGRATE_QUIET_TRIES: '3',
        MIGRATE_OS: 'Linux',
        TERM: 'dumb',
      };
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete baseEnv[key];
        else baseEnv[key] = value;
      }
      const notesArgs = phase === 'preflight' && args.includes('--notes') ? [] : ['--notes', sandbox.notes];
      const proc = Bun.spawn(
        ['bash', join(repo, 'migration', 'v4-to-v5', 'migrate.sh'), phase, ...notesArgs, ...args],
        {
          cwd: home,
          env: baseEnv,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, out, err, all: `${out}\n${err}` };
    },
    calls: async () => (await read(join(fakeDir, 'calls.log'))).split('\n').filter(Boolean),
    envLog: async () => (await read(join(fakeDir, 'env.log'))).split('\n').filter(Boolean),
    unscripted: async () => (await read(join(fakeDir, 'unscripted.log'))).split('\n').filter(Boolean),
    notesText: () => read(sandbox.notes),
    async daemonUp(opts = {}) {
      const target = opts.home ?? v4home;
      await mkdir(join(target, 'run'), { recursive: true });
      const spawnCmd = opts.comm === 'bun' ? "bun -e 'setTimeout(() => {}, 300000)'" : 'command -p sleep 300';
      const proc = Bun.spawn(['bash', '-c', `${spawnCmd} >/dev/null 2>&1 </dev/null & echo $!`], {
        stdout: 'pipe',
        stderr: 'ignore',
      });
      const pid = Number((await new Response(proc.stdout).text()).trim());
      await proc.exited;
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('fixture daemon did not start');
      fixtures.add(pid);
      await appendFile(join(fakeDir, 'fixture.pids'), `${pid}\n`);
      await writeFile(
        join(target, 'run', 'daemon.json'),
        JSON.stringify({
          format: 1,
          socket: join(target, 'run', 'fyd.sock'),
          host: '127.0.0.1',
          port: 9,
          pid,
          version: '5.0.0',
        }),
      );
      return pid;
    },
    async daemonDown() {
      await killFixtures();
      await rm(join(v4home, 'run', 'daemon.json'), { force: true });
    },
    async treeSignature(dir) {
      const proc = Bun.spawn(['find', dir, '-printf', '%p %T@ %y\\n'], { stdout: 'pipe', stderr: 'ignore' });
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      return text.split('\n').sort().join('\n');
    },
    async cleanup() {
      await killFixtures();
      listener?.stop(true);
      await rm(root, { recursive: true, force: true });
    },
    async everything() {
      const proc = Bun.spawn(['grep', '-rl', SECRET_VALUE, home], { stdout: 'pipe', stderr: 'ignore' });
      const hits = (await new Response(proc.stdout).text()).split('\n').filter(Boolean);
      await proc.exited;
      return hits.join('\n');
    },
  };

  // Defaults: a healthy v4 machine with Homebrew's v4 cask. A test overrides any fake.
  await sandbox.state('fy.version', '4.291.12\n');
  await sandbox.state('fyd.version', '4.291.12\n');
  await sandbox.state('ps.v4.json', V4_PS);
  await sandbox.state('ps.v5.json', V5_PS);
  await sandbox.state('board-open.json', BOARD_OPEN);
  await sandbox.state('board-closed.json', BOARD_EMPTY);
  await sandbox.state('board-dropped.json', BOARD_EMPTY);
  await sandbox.state('brew.casks', options.casks ?? 'ferretry@4\n');
  await sandbox.state('nix.profile', '');
  await sandbox.state('ps.out', '');
  await sandbox.state('panes.activity', '%1 100\n');
  await sandbox.state('dry.code', '0');
  await sandbox.state('real.code', '0');
  await installDefaults(sandbox);
  return sandbox;
}

/** Rules for every fake: the happy path of the whole switch. */
async function installDefaults(sb: Sandbox): Promise<void> {
  const D = '"$D"';
  const isV5 = `[[ "$(cat ${D}/fy.version)" == 5* ]]`;
  await sb.fake('fy', [
    { match: '--version', run: `cat ${D}/fy.version` },
    { match: 'ps -a --json', run: `if ${isV5}; then cat ${D}/ps.v5.json; else cat ${D}/ps.v4.json; fi; echo` },
    { match: 'board --project all --state open --all --json', run: `cat ${D}/board-open.json` },
    { match: 'board --project all --state closed --all --json', run: `cat ${D}/board-closed.json` },
    { match: 'board --project all --state dropped --all --json', run: `cat ${D}/board-dropped.json` },
    { match: 'secret ls --json', out: SECRET_LS },
    { match: 'daemon stop', run: DAEMON_DOWN_SH },
    { match: 'daemon start', run: DAEMON_UP_SH },
    { match: 'daemon update --major --yes --to *', run: `echo 5.0.0 > ${D}/fy.version; echo 5.0.0 > ${D}/fyd.version` },
    { match: 'config check', out: 'config ok' },
    { match: 'doctor', out: 'doctor clean' },
    { match: 'ask', out: 'no asks are waiting' },
    { match: 'restart *', out: 'restarted' },
  ]);
  await sb.fake('fyd', [
    { match: '--version', run: `cat ${D}/fyd.version` },
    { match: '--check', out: 'a Ferretry home — this daemon would use it' },
  ]);
  await sb.fake('tmux', [
    { match: '*window_activity*', run: `cat ${D}/panes.activity` },
    { match: '*session_name*', out: 'fy-f1 %1' },
    { match: '* ls', out: 'fy-f1: 1 windows' },
  ]);
  await sb.fake('sleep', [{ match: '*' }]);
  await sb.fake('fyd-browser-worker', [{ match: '--version', run: 'cat "$D/fyd.version"' }]);
  await sb.fake('ps', [
    { match: '-eo comm=', run: `cat ${D}/ps.out` },
    { match: '-eo args=', run: `cat ${D}/ps.out` }, // the pre-fix script read the whole command line
  ]);
  await sb.fake('xattr', [{ match: '-p com.apple.quarantine *', code: 1 }, { match: '-d com.apple.quarantine *' }]);
  await sb.fake('bun', [
    { match: 'install --frozen-lockfile' },
    {
      match: 'src/main.ts*--dry-run*',
      run: `exit "$(cat ${D}/dry.code)"`,
    },
    {
      match: 'src/main.ts*',
      run: `c="$(cat ${D}/real.code)"; if [ "$c" = 0 ]; then mkdir -p "$FAKE_H"; echo '{}' > "$FAKE_H/home.json"; mkdir -p "$FAKE_H/config" "$FAKE_H/state"; mkdir -p "$FAKE_H/config/logins"; echo "harness: claude" > "$FAKE_H/config/logins/alpha.yaml"; echo "harness: codex" > "$FAKE_H/config/logins/beta.yaml"; fi; exit "$c"`,
    },
  ]);
  await sb.fake('brew', [
    { match: 'list --cask', run: `cat ${D}/brew.casks` },
    { match: 'info --cask --json=v2 *', out: '{"casks":[{"version":"5.0.0"}]}' },
    {
      match: 'uninstall --cask *',
      run: `grep -vx "\${3}" ${D}/brew.casks > ${D}/brew.tmp; mv ${D}/brew.tmp ${D}/brew.casks`,
    },
    {
      match: 'install --cask kirinnee/ferretry/ferretry@4',
      run: `echo "ferretry@4" >> ${D}/brew.casks; echo 4.291.12 > ${D}/fy.version; echo 4.291.12 > ${D}/fyd.version`,
    },
    {
      match: 'install --cask kirinnee/ferretry/ferretry',
      run: `echo "ferretry" >> ${D}/brew.casks; echo 5.0.0 > ${D}/fy.version; echo 5.0.0 > ${D}/fyd.version`,
    },
    { match: 'upgrade --cask ferretry', run: `echo 5.0.0 > ${D}/fy.version; echo 5.0.0 > ${D}/fyd.version` },
  ]);
  await sb.fake('nix', [
    { match: 'profile list', run: `cat ${D}/nix.profile` },
    { match: 'flake metadata *' },
    { match: 'profile add --help' },
    { match: 'profile remove *', run: `: > ${D}/nix.profile` },
    {
      match: 'profile add github:kirinnee/ferretry/v5*',
      run: `printf 'Name: ferretry\\nOriginal flake URL: github:kirinnee/ferretry/v5.0.0\\n' > ${D}/nix.profile; echo 5.0.0 > ${D}/fy.version; echo 5.0.0 > ${D}/fyd.version`,
    },
    {
      match: 'profile add github:kirinnee/ferretry/v4*',
      run: `printf 'Name: ferretry\\nOriginal flake URL: github:kirinnee/ferretry/v4.291.12\\n' > ${D}/nix.profile; echo 4.291.12 > ${D}/fy.version; echo 4.291.12 > ${D}/fyd.version`,
    },
  ]);
}

/** Put a fake v5 build (fy + fyd printing 5.x) in `sb.v5bin` for `install --rehearsal-build`. */
export async function writeV5Build(sb: Sandbox): Promise<void> {
  for (const name of ['fy', 'fyd']) {
    const path = join(sb.v5bin, name);
    await writeFile(
      path,
      `#!/usr/bin/env bash\nD="\${FAKE_DIR:?}"\nprintf '%s|%s|PATH=%s|FY_URL=%s|FY_HOME=%s|FY_PORT=%s\\n' ${quote(`v5build-${name}`)} "$*" "$PATH" "\${FY_URL-<unset>}" "\${FY_HOME-<unset>}" "\${FY_PORT-<unset>}" >> "$D/env.log"\ncase "$*" in\n  --version) echo 5.0.0-rc.1 ;;\n  --check) echo "a Ferretry home — this daemon would use it" ;;\n  "ps -a --json") cat "$D/ps.v5.json" ;;\n  "daemon start") ${DAEMON_UP_SH} ;;\n  "daemon stop") ${DAEMON_DOWN_SH} ;;\n  *) printf '%s\\n' "$*" >> "$D/v5build.log" ;;\nesac\n`,
    );
    await chmod(path, 0o755);
  }
}

export const baselineArgs = ['--asks-open', '0'] as const;

/** Run every phase up to and including `last` (default: all the way to verify) against the default fakes. */
export async function advance(sb: Sandbox, last: string): Promise<void> {
  const order: [string, readonly string[]][] = [
    ['preflight', ['--notes', sb.notes]],
    ['baseline', baselineArgs],
    ['quiet', ['--owner-confirmed']],
    ['backup', ['--owner-yes']],
    ['convert', []],
    ['install', []],
    ['start', []],
    ['verify', []],
  ];
  for (const [phase, args] of order) {
    const result = await sb.run(phase, args);
    if (result.code !== 0) throw new Error(`${phase} exited ${result.code}: ${result.all}`);
    if (phase === last) return;
  }
}

export { dirname };
