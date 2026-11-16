import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { escapeTmuxFormat } from '../../../../daemon/lib/tmux/format-escape.ts';
import { scriptLine } from '../../../../daemon/lib/tmux/script.ts';
import { waitForValue } from '../support/wait-for.ts';

/**
 * The edge-case matrix for `-c`, on a PRIVATE tmux server (`tmux -L <unique>`, no config file): the daemon's own
 * server is never touched. Ported from the f4422 security probe. Only harmless format markers are used
 * (`#{session_name}`), never a command-execution payload: a marker that expanded would show up as a different
 * directory, which is exactly what is asserted.
 *
 * Each name is made a real directory, then every start-directory command is run with the ESCAPED name over both
 * transports (argv, and the `source-file -` script the runner uses) and must open in exactly that directory.
 */
const TMUX = Bun.which('tmux');
const label = `fy-cwdmx-${process.pid}-${Date.now()}`;
let root = '';

function tmux(args: readonly string[], stdin?: string): { code: number; out: string; err: string } {
  const result = Bun.spawnSync([TMUX as string, '-L', label, '-f', '/dev/null', ...args], {
    env: { ...process.env, TMUX: '' },
    cwd: root,
    stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: result.exitCode, out: result.stdout.toString().trimEnd(), err: result.stderr.toString().trimEnd() };
}

const must = (args: readonly string[], stdin?: string): string => {
  const r = tmux(args, stdin);
  if (r.code !== 0) throw new Error(`tmux ${args.join(' ')} failed: ${r.err}`);
  return r.out;
};

beforeAll(async () => {
  if (TMUX === null) throw new Error('tmux is required for this test and was not found');
  root = await realpath(await mkdtemp(join(tmpdir(), 'fy-cwdmx-')));
  must(['new-session', '-d', '-s', 'base', '-c', root, '/bin/sleep', '300']);
});

afterAll(async () => {
  if (TMUX !== null) tmux(['kill-server']);
  if (root !== '') await rm(root, { recursive: true, force: true });
});

const NAMES: ReadonlyArray<readonly [string, string]> = [
  ['spaces', 'space folder'],
  ['both quote types', 'single\' double"'],
  ['percent', 'percent%'],
  ['literal ##', 'literal##'],
  ['trailing #', 'trailing#'],
  ['unicode', 'unicode-雪🦦'],
  ['#{session_name}', '#{session_name}'],
  ['already-doubled ##{session_name}', '##{session_name}'],
  ['###', '###'],
  ['empty #()', '#()'],
  ['literal ##(', '##('],
];

const COMMANDS = ['new-session', 'new-window', 'split-window', 'respawn-pane'] as const;
const TRANSPORTS = ['argv', 'source-file'] as const;

let counter = 0;

function startArguments(command: (typeof COMMANDS)[number], directory: string): string[] {
  const name = `m${counter++}`;
  const program = ['/bin/sleep', '300'];
  switch (command) {
    case 'new-session':
      return [command, '-d', '-P', '-F', '#{pane_id}', '-s', name, '-c', directory, ...program];
    case 'new-window':
      return [command, '-d', '-P', '-F', '#{pane_id}', '-t', 'base:', '-c', directory, ...program];
    case 'split-window':
      return [command, '-d', '-P', '-F', '#{pane_id}', '-t', 'base:0', '-c', directory, ...program];
    case 'respawn-pane':
      return [command, '-k', '-t', 'base:0.0', '-c', directory, ...program];
  }
}

describe('a start directory named like a tmux format, on a private server', () => {
  for (const [description, leaf] of NAMES) {
    for (const command of COMMANDS) {
      for (const transport of TRANSPORTS) {
        it(`should open ${description} verbatim through ${command} (${transport})`, async () => {
          // Arrange
          const path = join(root, leaf);
          await mkdir(path, { recursive: true });
          const args = startArguments(command, escapeTmuxFormat(path));
          // Act
          const made = transport === 'argv' ? must(args) : must(['source-file', '-'], scriptLine(args));
          // Assert
          const pane = command === 'respawn-pane' ? 'base:0.0' : made;
          const where = await waitForValue(async () => {
            const r = tmux(['display-message', '-p', '-t', pane, '#{pane_current_path}']);
            return r.code === 0 && r.out !== '' ? r.out : undefined;
          }, 'the pane to report its directory');
          should(where).equal(path);
          if (command === 'split-window') must(['kill-pane', '-t', made]);
        });
      }
    }
  }

  it('should treat an already-doubled name as the literal name, not decode it first', () => {
    should(escapeTmuxFormat('/r/##{session_name}')).equal('/r/####{session_name}');
  });

  it('should show the escape is needed: an unescaped #{pid} in -c names a different directory', async () => {
    // Arrange
    const pid = must(['display-message', '-p', '#{pid}']);
    const raw = join(root, 'marker-#{pid}');
    const expanded = join(root, `marker-${pid}`);
    await mkdir(raw, { recursive: true });
    await mkdir(expanded, { recursive: true });
    // Act
    const pane = must(startArguments('split-window', raw));
    // Assert
    const where = await waitForValue(async () => {
      const r = tmux(['display-message', '-p', '-t', pane, '#{pane_current_path}']);
      return r.code === 0 && r.out !== '' ? r.out : undefined;
    }, 'the pane to report its directory');
    should(where).equal(expanded);
    must(['kill-pane', '-t', pane]);
  });
});
