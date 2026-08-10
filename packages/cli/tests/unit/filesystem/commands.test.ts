import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerFilesystemCommands } from '../../../src/lib/filesystem/commands.ts';
import { FilesystemController } from '../../../src/lib/filesystem/controller.ts';
import { CapturingOutput, RecordingFilesystemGateway } from './fixtures.ts';

function run(argv: string[]) {
  const gateway = new RecordingFilesystemGateway();
  const out = new CapturingOutput();
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerFilesystemCommands(program, new FilesystemController(gateway, out));
  return { parsed: program.parseAsync(['node', 'fy', ...argv]), gateway, out };
}

describe('filesystem command surface', () => {
  it('should list through both group spellings', async () => {
    // Arrange + Act
    const first = run(['fs', 'ls', 'Fable', 'src']);
    const second = run(['files', 'list', 'Fable']);
    await first.parsed;
    await second.parsed;

    // Assert
    should(first.gateway.calls[0]).deepEqual({ method: 'list', args: ['Fable', 'src'] });
    should(second.gateway.calls[0]).deepEqual({ method: 'list', args: ['Fable', undefined] });
  });

  it('should map file, change, and diff options', async () => {
    // Arrange + Act
    const file = run(['fs', 'file', 'Fable', 'src/app.ts', '--head', '--json']);
    const changes = run(['fs', 'changes', 'Fable', '--json']);
    const diff = run(['fs', 'diff', 'Fable', 'src/app.ts', '--json']);
    await file.parsed;
    await changes.parsed;
    await diff.parsed;

    // Assert
    should(file.gateway.calls[0]).deepEqual({ method: 'file', args: ['Fable', 'src/app.ts', 'head'] });
    should(changes.gateway.calls[0]?.method).equal('changes');
    should(diff.gateway.calls[0]?.method).equal('diff');
    should(JSON.parse(file.out.messages[0] ?? '')).have.property('path', 'src/app.ts');
  });
});

describe('the index command', () => {
  it('should read the index through both spellings and pass the query on', async () => {
    // Arrange + Act
    const plain = run(['fs', 'index', 'Fable']);
    const searched = run(['files', 'search', 'Fable', '--query', 'app', '--json']);
    await plain.parsed;
    await searched.parsed;

    // Assert
    should(plain.gateway.calls[0]).deepEqual({ method: 'index', args: ['Fable'] });
    should(searched.gateway.calls[0]).deepEqual({ method: 'index', args: ['Fable'] });
    should(JSON.parse(searched.out.messages[0] ?? '')).match({ files: [{ name: 'app.ts' }] });
  });
});
