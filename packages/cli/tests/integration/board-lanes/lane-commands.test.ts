import { describe, it } from 'bun:test';
import type { BoardProjectId, LaneSetActionRequest } from '@ferretry/protocol';
import { Command } from 'commander';
import should from 'should';
import { registerLaneCommands } from '../../../src/adapters/board-lanes/lane-commands';
import type { ILaneGateway } from '../../../src/lib/board-lanes/ports';
import { FERRETRY_ID, laneSet, listing, project } from './fixtures';

const harness = (program = new Command().exitOverride()) => {
  const changes: { projectId: BoardProjectId; request: LaneSetActionRequest }[] = [];
  const switched: { projectId: BoardProjectId; on: boolean }[] = [];
  const lines: string[] = [];
  const gateway: ILaneGateway = {
    projects: () => Promise.resolve(listing({ current: FERRETRY_ID as BoardProjectId })),
    project: () => Promise.resolve(project()),
    change: (projectId, request) => {
      changes.push({ projectId, request });
      return Promise.resolve({ laneSet: laneSet({ version: 4 }), agenda: 'raised' });
    },
    switchOf: projectId => Promise.resolve({ projectId, on: false, setBy: 'default', setAt: null }),
    setSwitch: (projectId, on) => {
      switched.push({ projectId, on });
      return Promise.resolve({ projectId, on, setBy: 'owner', setAt: '2026-11-01T12:00:00.000Z' });
    },
  };
  registerLaneCommands(program, { gateway, io: { success: line => lines.push(line) }, binaryName: 'fy' });
  return { changes, switched, lines, program };
};

const run = async (program: Command, ...args: string[]) => {
  await program.parseAsync(['bun', 'fy', 'board', 'lanes', ...args]);
};

describe('the lane commands', () => {
  it('should propose a template with its renames', async () => {
    const { changes, lines, program } = harness();
    await run(program, 'propose', '--template', 'pr', '--rename', 'review=look', '--rename', 'merged=shipped');
    should(changes[0]?.request).eql({
      action: 'propose',
      template: 'pr',
      renames: { review: 'look', merged: 'shipped' },
    });
    should(lines[0]).match(/Ferretry lanes, version 4/u);
  });

  it('should show the lanes as JSON on request', async () => {
    const { lines, program } = harness();
    await run(program, 'show', '--json', '--project', 'Ferretry');
    should(JSON.parse(lines[0] ?? '')).have.property('name', 'Ferretry');
  });

  it('should edit by renaming and removing lanes', async () => {
    const { changes, program } = harness();
    await run(program, 'edit', '--rename', 'implement=look', '--remove', 'plan', '--into', 'todo');
    should(changes[0]?.request).have.property('action', 'edit');
  });

  it('should read and throw the board switch', async () => {
    const { switched, lines, program } = harness();
    await program.parseAsync(['bun', 'fy', 'board', 'status']);
    await program.parseAsync(['bun', 'fy', 'board', 'on', '--project', 'Ferretry']);
    await program.parseAsync(['bun', 'fy', 'board', 'off', '--json', '--project', 'Ferretry']);
    should(lines[0]).startWith('Ferretry: board off — nobody switched it on.');
    should(lines[1]).startWith('Ferretry: board on — set by the owner');
    should(JSON.parse(lines[2] ?? '')).containEql({ on: false, setBy: 'owner' });
    should(switched).eql([
      { projectId: FERRETRY_ID, on: true },
      { projectId: FERRETRY_ID, on: false },
    ]);
  });

  it('should join a board group that already exists instead of making a second one', async () => {
    const existing = new Command().exitOverride();
    existing.command('board');
    const { changes, program } = harness(existing);
    await run(program, 'propose', '--template', 'pr');
    should(program.commands.filter(command => command.name() === 'board')).have.length(1);
    should(changes).have.length(1);
  });
});
