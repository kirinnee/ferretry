import { describe, it } from 'bun:test';
import type { IFyApiClient, ProjectInfo } from '@ferretry/protocol';
import { Command } from 'commander';
import should from 'should';
import { FyProjectGateway } from '../../../src/adapters/projects/fy-project-gateway';
import { registerProjectCommands } from '../../../src/adapters/projects/project-commands';

const PROJECT: ProjectInfo = {
  id: '0b1f6d1e-6c1b-4f0c-8f4e-2f6f2a3c9a10',
  name: 'ferretry',
  path: '/work/ferretry',
  source: 'existing-folder',
  createdAt: '2026-10-30T10:00:00.000Z',
};

/** A daemon client that answers every GET with the registry and every POST with the new project. */
const client = (registry: ProjectInfo[]) => {
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  const request = ((path: string, schema: { parse(value: unknown): unknown }, init?: RequestInit) => {
    calls.push({ path, init });
    return Promise.resolve(schema.parse(init?.method === 'POST' ? PROJECT : registry));
  }) as unknown as IFyApiClient['request'];
  return { calls, client: { request } };
};

const harness = (registry: ProjectInfo[] = []) => {
  const { calls, client: fake } = client(registry);
  const lines: string[] = [];
  const program = new Command().name('fy').exitOverride();
  registerProjectCommands(program, {
    gateway: new FyProjectGateway(fake),
    io: { success: line => lines.push(line) },
    cwd: '/work/ferretry',
    binaryName: 'fy',
  });
  const run = async (...argv: string[]) => void (await program.parseAsync(['bun', 'fy', ...argv]));
  return { calls, lines, run };
};

describe('the project commands', () => {
  it('should post `project add .` as the absolute folder to the registry', async () => {
    const { calls, lines, run } = harness();
    await run('project', 'add', '.', '--name', 'ferretry');
    should(calls.map(call => [call.path, call.init?.method ?? 'GET'])).eql([
      ['/v1/projects', 'GET'],
      ['/v1/projects', 'POST'],
    ]);
    should(JSON.parse(String(calls[1]?.init?.body))).eql({
      kind: 'existing-folder',
      path: '/work/ferretry',
      name: 'ferretry',
    });
    should(lines[0]).startWith('registered: ferretry');
  });

  it('should say a folder is already registered when the registry held it before', async () => {
    const { lines, run } = harness([PROJECT]);
    await run('project', 'add', '/work/ferretry');
    should(lines[0]).startWith('already registered: ferretry');
  });

  it('should list the registry, also as `projects list`', async () => {
    const { lines, run } = harness([PROJECT]);
    await run('project', 'ls');
    await run('projects', 'list', '--json');
    should(lines[0]).equal(`ferretry  ${PROJECT.id}  /work/ferretry`);
    should(JSON.parse(lines[1] ?? '')).eql([PROJECT]);
  });
});
