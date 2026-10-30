import type { Command } from 'commander';
import type { IProjectGateway, IProjectOutput } from '../../lib/projects/ports';
import { type ProjectAddOptions, ProjectController } from '../../lib/projects/project-controller';

export interface ProjectCommandDependencies {
  readonly gateway: IProjectGateway;
  readonly io: IProjectOutput;
  /** The invocation directory: `fy project add .` means the folder the caller stands in. */
  readonly cwd: string;
  readonly binaryName: string;
}

/** `fy project add|ls`: register a folder as a project (its board comes with it) and list the registry. */
export function registerProjectCommands(program: Command, dependencies: ProjectCommandDependencies): Command {
  const controller = new ProjectController(
    dependencies.gateway,
    dependencies.io,
    dependencies.cwd,
    dependencies.binaryName,
  );
  const group = program
    .command('project')
    .alias('projects')
    .description('the projects this machine knows; each one has a board');

  group
    .command('add')
    .description('register a folder as a project; a folder (or git repo) already registered prints the one it is')
    .argument('<path>', 'the folder, such as `.`')
    .option('--name <name>', "the project's name; default: the folder's name")
    .option('--json', 'print the project as JSON, with whether it was created')
    .action(async (path: string, options: ProjectAddOptions) => {
      await controller.add(path, options);
    });

  group
    .command('ls')
    .alias('list')
    .description('every registered project: name, id and folder')
    .option('--json', 'print the registry as JSON')
    .action(async (options: { readonly json?: boolean }) => {
      await controller.list(options);
    });

  return group;
}
