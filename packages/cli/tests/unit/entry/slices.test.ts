import { describe, it } from 'bun:test';
import type { Command } from 'commander';
import should from 'should';
import { registerMcpGroup } from '../../../bin/mcp-group.ts';
import { registerDomain } from '../../../bin/program.ts';
import { registerReadsGroup } from '../../../bin/reads-group.ts';
import { type ConnectionWorld, createProgram, type SliceRegistrar, wireDaemon } from '../../../bin/wiring.ts';
import type { ICliIo } from '../../../src/adapters/terminal/console-io.ts';
import { type EntrySlice, entrySlice, SLICE_COMMANDS } from '../../../src/lib/entry/route.ts';
import { NO_PROGRESS } from '../../../src/lib/progress/index.ts';

/**
 * The slices `bin/fy.ts` loads instead of the full program must be the full program's commands, not a
 * copy of them: the same names, the same options, the same help. Building every program here, without
 * running a command, is what lets a group change in one place and keep both in step.
 */
const silent: ICliIo = {
  success: () => undefined,
  report: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  diagnostic: () => undefined,
  setExitCode: () => undefined,
  interactive: () => false,
};

const world: ConnectionWorld = { io: silent, cwd: '/work', homeDirectory: '/home/tester', environment: {} };

const SLICES: Readonly<Record<EntrySlice, SliceRegistrar>> = {
  reads: registerReadsGroup,
  mcp: (program, sliceWorld, wiring) => {
    registerMcpGroup(program, sliceWorld, wiring);
  },
};

function fullProgram(): Command {
  const program = createProgram();
  registerDomain(program, {
    ...world,
    progress: NO_PROGRESS,
    spinner: { start: () => undefined, succeed: () => undefined, fail: () => undefined },
    prompt: {
      ask: () => Promise.reject(new Error('no prompt in a unit test')),
      askHidden: () => Promise.reject(new Error('no prompt in a unit test')),
    },
    interactive: false,
  });
  return program;
}

function sliceProgram(slice: EntrySlice): Command {
  const program = createProgram();
  SLICES[slice](program, world, wireDaemon(program, world));
  return program;
}

/** Every command under `command`, keyed by its path, with the help text it prints. */
function helpByPath(command: Command, prefix: readonly string[] = []): Map<string, string> {
  const found = new Map<string, string>();
  for (const child of command.commands) {
    const path = [...prefix, child.name()];
    found.set(path.join(' '), child.helpInformation());
    for (const [nested, help] of helpByPath(child, path)) found.set(nested, help);
  }
  return found;
}

describe('entry slices', () => {
  it('should register exactly the top-level commands each slice is routed', () => {
    // Arrange
    const slices = Object.keys(SLICE_COMMANDS) as EntrySlice[];

    // Act
    const registered = slices.map(slice => sliceProgram(slice).commands.map(command => command.name()));

    // Assert
    should(registered).eql(slices.map(slice => [...SLICE_COMMANDS[slice]]));
  });

  it('should print the full program help byte for byte for every sliced command', () => {
    // Arrange
    const full = helpByPath(fullProgram());

    // Act + Assert — every command a slice owns, its subcommands included.
    for (const slice of Object.keys(SLICE_COMMANDS) as EntrySlice[]) {
      const sliced = helpByPath(sliceProgram(slice));
      should(sliced.size).be.above(0);
      for (const [path, help] of sliced) should({ path, help }).eql({ path, help: full.get(path) });
    }
  });

  it('should send every other command to the full program', () => {
    // Arrange
    const sliced = new Set(Object.values(SLICE_COMMANDS).flat());
    const others = fullProgram()
      .commands.map(command => command.name())
      .filter(name => !sliced.has(name));

    // Act
    const routed = others.map(name => entrySlice([name]));

    // Assert
    should(others.length).be.above(20);
    should(routed).eql(others.map(() => undefined));
  });
});
