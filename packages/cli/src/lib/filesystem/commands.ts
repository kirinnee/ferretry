import type { Command } from 'commander';
import type { FilesystemController } from './controller.ts';

const json = (command: Command): Command =>
  command.option('--json', 'print the schema-parsed daemon response instead of the human rendering');

/** Mounts the read-only session working-tree viewer as `fy fs …`. */
export function registerFilesystemCommands(program: Command, controller: FilesystemController): void {
  const fs = program
    .command('fs')
    .alias('files')
    .description("read a session's descriptor-confined working tree (never writes)");

  json(
    fs.command('ls').alias('list').argument('<id>', 'session id or callsign').argument('[path]', 'relative directory'),
  ).action(async (id: string, path: string | undefined, options: { json?: boolean }) => {
    await controller.list(id, path, options);
  });

  json(
    fs
      .command('cat')
      .alias('file')
      .argument('<id>', 'session id or callsign')
      .argument('<path>', 'relative file path')
      .option('--head', 'read the file recorded in Git HEAD instead of the working tree'),
  ).action(async (id: string, path: string, options: { head?: boolean; json?: boolean }) => {
    await controller.file(id, path, options);
  });

  json(fs.command('changes').argument('<id>', 'session id or callsign')).action(
    async (id: string, options: { json?: boolean }) => {
      await controller.changes(id, options);
    },
  );

  json(
    fs.command('diff').argument('<id>', 'session id or callsign').argument('<path>', 'relative changed path'),
  ).action(async (id: string, path: string, options: { json?: boolean }) => {
    await controller.diff(id, path, options);
  });
}
