import type { Command } from 'commander';
import { LaneController } from '../../lib/board-lanes/lane-controllers';
import type { LaneEditOptions, LaneProposeOptions } from '../../lib/board-lanes/lane-request';
import type { ILaneGateway, ILaneOutput } from '../../lib/board-lanes/ports';

export interface LaneCommandDependencies {
  readonly gateway: ILaneGateway;
  readonly io: ILaneOutput;
  readonly binaryName: string;
}

interface TargetOptions {
  readonly project?: string;
  readonly json?: boolean;
}

const collect = (value: string, previous: readonly string[]): readonly string[] => [...previous, value];

const targeted = (command: Command): Command =>
  command
    .option('--project <name>', "the project's name or id; default: the board of the calling session")
    .option('--json', 'print the daemon response as JSON');

const target = (options: TargetOptions) => ({ project: options.project, json: options.json === true });

/** The `board` group is U4's; this adds its `lanes` subgroup to whichever of us created it first. */
export function registerLaneCommands(program: Command, dependencies: LaneCommandDependencies): Command {
  const controller = new LaneController(dependencies.gateway, dependencies.io, dependencies.binaryName);
  const board =
    program.commands.find(command => command.name() === 'board') ??
    program.command('board').description('the project board');
  const group = board.command('lanes').description("a project's lanes: propose, show and edit");

  targeted(group.command('propose'))
    .description('propose a lane set from a template; it is live at once and the owner is asked to accept it')
    .requiredOption('--template <template>', 'pr-release-verify | pr-release | pr | ops | writing | quick')
    .option('--rename <old=new>', 'give a template lane another name, by lane id (repeatable)', collect, [])
    .action(async (options: LaneProposeOptions & TargetOptions) => {
      await controller.propose(target(options), options);
    });

  targeted(group.command('show'))
    .description("a project's lanes, in order, with each lane's id")
    .action(async (options: TargetOptions) => {
      await controller.show(target(options));
    });

  targeted(group.command('edit'))
    .description('rename lanes (their cards stay) or remove one and say where its cards go')
    .option('--rename <old=new>', 'give a lane another name, by lane id (repeatable)', collect, [])
    .option('--remove <lane>', 'remove a lane by id (repeatable)', collect, [])
    .option('--into <lane>', 'the lane that receives the cards of every removed lane')
    .action(async (options: LaneEditOptions & TargetOptions) => {
      await controller.edit(target(options), options);
    });

  return group;
}
