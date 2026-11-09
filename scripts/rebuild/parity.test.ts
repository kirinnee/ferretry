import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const generator = join(import.meta.dir, 'parity.ts');
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'fy-parity-'));
  temporary.push(directory);
  const source = join(directory, 'source');
  const output = join(directory, 'output');
  mkdirSync(source);
  const put = (file: string, content: string) => {
    const path = join(source, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  put(
    'packages/daemon/src/lib/paths.ts',
    `
    import { join } from 'node:path';
    export function createFoundationPaths(home: string) {
      const state = join(home, 'state');
      return { home, state, sessions: join(state, 'sessions') };
    }
    export function createSessionPaths(paths: object, sessionId: string) {
      const directory = join(paths.sessions, sessionId);
      return { directory, config: join(directory, 'config.json') };
    }
  `,
  );
  put(
    'packages/cli/bin/wiring.ts',
    `
    import { Command } from 'commander';
    export function createProgram() { return new Command().name('fy').option('--global'); }
  `,
  );
  put(
    'packages/cli/bin/program.ts',
    `
    import { registerCommands } from '../src/lib/board/commands';
    const DOMAIN_REGISTRARS = [({ program }) => registerCommands(program, { unsafe: true })];
    function registerDoctorCommand(program) { program.command('doctor'); }
    throw new Error('IMPORTING THE PROGRAM IS FORBIDDEN');
  `,
  );
  put(
    'packages/cli/src/lib/board/commands.ts',
    `
    function acting(command) { return command.option('--json'); }
    export function registerCommands(program, controller) {
      const task = program.command('task').option('--session <id>');
      for (const verb of ['show', 'patch']) acting(task.command(verb)).argument('<id>')
        .option('-f, --file <path>').action(() => { throw new Error('action must not run'); });
      acting(task.command('ls').alias('list'));
    }
  `,
  );
  put(
    'packages/daemon/src/lib/runtime/mounts/board.ts',
    `
    import { USE } from '@ferretry/protocol';
    const SCOPE = { minimum: 'operator', caller: 'person', capability: USE } as const;
    export function routes() { return [
      { ...SCOPE, method: 'GET', path: '/v1/sessions/:id/files', privilegedOnly: true,
        unlockExempt: true, wardenRemedy: { action: 'inspect' }, handle: () => 'never run' },
      { method: 'GET', path: '/v1/sessions/:id/stream', minimum: 'authenticated', caller: 'any', accept: () => 'never run' }
    ]; }
    const auditOnly = { method: 'DELETE', path: '/audit-only', event: 'removed' };
  `,
  );
  put('packages/protocol/src/lib/index.ts', "export { USE } from './guard.ts';");
  put('packages/protocol/src/lib/guard.ts', "export const USE = { capability: 'filesystem', axis: 'use' } as const;");
  put(
    'packages/daemon/bin/modules/board.ts',
    `
    import { FileStore } from '../../src/adapters/board/file-store';
    const store = new FileStore(join(paths.state, 'board'));
    setInterval(() => store.sweep(), 1000);
    export const jobs = { jobs: { arm: () => store.arm() } };
  `,
  );
  put(
    'packages/daemon/src/adapters/board/file-store.ts',
    `
    export class FileStore {
      constructor(private readonly directory: string) {}
      write() { return join(this.directory, 'cards.json'); }
    }
    const old = join(paths.home, 'operator-password.json');
  `,
  );
  put(
    'packages/cli/src/lib/mcp/tools.ts',
    `
    export const MCP_TOOLS = [{ name: 'terminal_read', tool: 'terminal.read',
      description: 'Read a terminal.', inputSchema: object({}) }];
  `,
  );
  put(
    'packages/pwa/src/lib/pages/routes.ts',
    [
      "export interface PageRoute { kind: 'board' }",
      'export const daemonHomePath = (id: string) => `/d/${encodeURIComponent(id)}`;',
      'export const daemonBoardPath = (id: string) => `${daemonHomePath(id)}/board`;',
    ].join('\n'),
  );
  put(
    'packages/pwa/src/features/settings/page.tsx',
    `
    export function BoardSheet() { return <div />; }
    const SETTINGS = [{ id: 'cards', label: 'Cards', panels: ['board'], tab: 'work' }];
  `,
  );
  const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], { stdio: 'pipe' });
  git('init', '--quiet');
  git('add', '.');
  git(
    '-c',
    'user.name=Parity Fixture',
    '-c',
    'user.email=parity@example.invalid',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '--quiet',
    '--no-gpg-sign',
    '-m',
    'fixture',
  );
  const run = (...args: string[]) =>
    Bun.spawnSync([process.execPath, generator, '--source', source, '--out-dir', output, ...args], {
      env: { ...process.env, FY_HOME: join(directory, 'untouched-home') },
      stdout: 'pipe',
      stderr: 'pipe',
    });
  const rows = () =>
    readFileSync(join(output, 'rebuild-parity.tsv'), 'utf8')
      .trimEnd()
      .split('\n')
      .slice(1)
      .map(line => {
        const [id, kind, what = '', source, todayOwner, owner, name5, descriptor, check, status] = line.split('\t');
        return { id, kind, what, source, todayOwner, owner, name5, descriptor, check, status };
      });
  return { directory, source, output, put, git, run, rows };
}

test('extracts security descriptors, nested Commander flags, tools, UI, jobs and confined storage without executing product code', () => {
  const f = fixture();
  const result = f.run();
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const rows = f.rows();
  const route = rows.find(row => row.what === 'GET /v1/sessions/:id/files')!;
  expect(route.name5).toBe('GET /v1/ferrets/:id/files');
  expect(route.descriptor).toContain('minimum=operator; caller=person');
  expect(route.descriptor).toContain('capability={"capability":"filesystem","axis":"use"}');
  expect(route.descriptor).toContain('privilegedOnly=true; unlockExempt=true');
  expect(route.descriptor).toContain('wardenRemedy={"action":"inspect"}');
  expect(route.check).toBe('descriptor-parity');
  expect(rows.some(row => row.what === 'WS GET /v1/sessions/:id/stream')).toBe(true);
  expect(rows.some(row => row.what.includes('/audit-only'))).toBe(false);
  const command = rows.find(row => row.what === 'fy task patch <id>')!;
  expect(command.name5).toBe('fy card patch <id>');
  for (const flag of ['--global', '--json', '--session <id>', '-f, --file <path>'])
    expect(command.descriptor).toContain(flag);
  expect(rows.find(row => row.what === 'fy task list')!.status).toContain('removed by design (§1.4');
  expect(rows.find(row => row.what === 'terminal_read')!.owner).toBe('terminals');
  expect(rows.some(row => row.what === 'route daemonBoardPath: /d/:daemonId/board')).toBe(true);
  expect(rows.some(row => row.what === 'component BoardSheet')).toBe(true);
  expect(rows.some(row => row.what === 'settings panel board')).toBe(true);
  expect(rows.some(row => row.kind === 'J' && row.what.includes('setInterval'))).toBe(true);
  expect(rows.some(row => row.kind === 'J' && row.what.includes('module job'))).toBe(true);
  expect(rows.find(row => row.what === 'FY_HOME/state/board/cards.json')!.owner).toBe('board');
  expect(rows.find(row => row.what === 'FY_HOME/operator-password.json')!.status).toContain('removed by design (§9.2');
  expect(existsSync(join(f.directory, 'untouched-home'))).toBe(false);
});

test('regeneration preserves reviewed IDs/status, gives new features new unchecked rows and detects stale artifacts', () => {
  const f = fixture();
  expect(f.run().exitCode).toBe(0);
  expect(f.run('--check').exitCode).toBe(0);
  const row = f.rows().find(row => row.what === 'fy task patch <id>')!;
  const tsvPath = join(f.output, 'rebuild-parity.tsv');
  writeFileSync(
    tsvPath,
    readFileSync(tsvPath, 'utf8')
      .split('\n')
      .map(line => (line.startsWith(`${row.id}\t`) ? line.replace(/\[ \]$/, '[x]') : line))
      .join('\n'),
  );
  expect(f.run('--check').exitCode).not.toBe(0);
  f.put(
    'packages/daemon/src/lib/runtime/mounts/additional.ts',
    `
    export const extra = [{ method: 'POST', path: '/v1/new', minimum: 'operator', caller: 'person', handle: () => {} }];
  `,
  );
  f.git('add', '.');
  expect(f.run().exitCode).toBe(0);
  const current = f.rows();
  expect(current.find(entry => entry.what === row.what)!.id).toBe(row.id);
  expect(current.find(entry => entry.what === row.what)!.status).toBe('[x]');
  expect(current.find(entry => entry.what === 'POST /v1/new')!.status).toBe('[ ]');
  expect(new Set(current.map(entry => entry.id)).size).toBe(current.length);
  expect(f.run('--check').exitCode).toBe(0);
});

test("regeneration keeps a ticked route row's test path, and gives a reverted row back the default check", () => {
  const f = fixture();
  expect(f.run().exitCode).toBe(0);
  const what = 'GET /v1/sessions/:id/files';
  const tsvPath = join(f.output, 'rebuild-parity.tsv');
  const rewrite = (check: string, status: string) =>
    writeFileSync(
      tsvPath,
      readFileSync(tsvPath, 'utf8')
        .split('\n')
        .map(line => {
          const cells = line.split('\t');
          if (cells[2] !== what) return line;
          cells[8] = check;
          cells[9] = status;
          return cells.join('\t');
        })
        .join('\n'),
    );
  const testPath = 'packages/daemon/tests/unit/routes/files.test.ts';
  rewrite(testPath, '[x]');
  expect(f.run().exitCode).toBe(0);
  expect(f.rows().find(row => row.what === what)).toMatchObject({ check: testPath, status: '[x]' });
  // The tick is reverted by changing only the status: the old test path must not stay on an open row.
  rewrite(testPath, '[ ]');
  expect(f.run().exitCode).toBe(0);
  expect(f.rows().find(row => row.what === what)).toMatchObject({ check: 'descriptor-parity', status: '[ ]' });
  expect(f.run('--check').exitCode).toBe(0);
});

test('BG-060 a ticked route row that REOWNED moves keeps its test path on regeneration, and an open one gets the default', () => {
  const f = fixture();
  expect(f.run().exitCode).toBe(0);
  const what = 'GET /v1/sessions/:id/files';
  const tsvPath = join(f.output, 'rebuild-parity.tsv');
  // R-0424 is a REOWNED id (the fleet event socket, re-owned to Ferrets): give the fixture route that id.
  const rewrite = (check: string, status: string) =>
    writeFileSync(
      tsvPath,
      readFileSync(tsvPath, 'utf8')
        .split('\n')
        .map(line => {
          const cells = line.split('\t');
          if (cells[2] !== what) return line;
          cells[0] = 'R-0424';
          cells[8] = check;
          cells[9] = status;
          return cells.join('\t');
        })
        .join('\n'),
    );
  const testPath = 'packages/core/ferrets/tests/unit/routes/events.test.ts';
  rewrite(testPath, '[x]');
  expect(f.run().exitCode).toBe(0);
  expect(f.rows().find(row => row.what === what)).toMatchObject({
    id: 'R-0424',
    owner: 'ferrets',
    check: testPath,
    status: '[x]',
  });
  expect(f.run('--check').exitCode).toBe(0);
  rewrite(testPath, '[ ]');
  expect(f.run().exitCode).toBe(0);
  expect(f.rows().find(row => row.what === what)).toMatchObject({
    owner: 'ferrets',
    check: 'descriptor-parity',
    status: '[ ]',
  });
});
