import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerCopyCommands } from '../../../src/lib/copy/commands';
import type { CopyController } from '../../../src/lib/copy/controller';

/** A controller that records which verb each command line reached, and with what. */
function run(argv: string[]) {
  const reached: unknown[] = [];
  const record =
    (verb: string) =>
    async (...args: unknown[]): Promise<void> =>
      void reached.push([verb, ...args]);
  const controller = {
    list: record('list'),
    rules: record('rules'),
    addRule: record('addRule'),
    removeRule: record('removeRule'),
    plans: record('plans'),
    approve: record('approve'),
  } as unknown as CopyController;
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerCopyCommands(program, controller);
  return { reached, parsed: program.parseAsync(['node', 'fy', ...argv]) };
}

describe('fy copy commands', () => {
  it('should reach each verb with its flags and arguments', async () => {
    const lines = [
      ['copy', 'ls', '--session', 's1', '--json'],
      ['copy', 'rules', 'ls'],
      ['copy', 'rules', 'add', '--from', 'command:gh', '--to', 'terminal:vercel', '--count', '2', '--expires', '2h'],
      ['copy', 'rules', 'rm', 'a1b2'],
      ['copy', 'plan', 'ls', '--session', 's1'],
      ['copy', 'plan', 'approve', 'feed', '1', '3'],
    ];
    const reached: unknown[] = [];
    for (const line of lines) {
      const ran = run(line);
      await ran.parsed;
      reached.push(...ran.reached);
    }

    should(reached).match([
      ['list', { session: 's1', json: true }],
      ['rules', {}],
      ['addRule', { from: 'command:gh', to: 'terminal:vercel', count: '2', expires: '2h' }],
      ['removeRule', 'a1b2', {}],
      ['plans', { session: 's1' }],
      ['approve', 'feed', ['1', '3'], {}],
    ]);
  });

  it('should refuse a rule without its route before reaching the controller', async () => {
    const ran = run(['copy', 'rules', 'add', '--from', 'command:gh']);

    should(
      await ran.parsed.then(
        () => 'ran',
        () => 'refused',
      ),
    ).equal('refused');
    should(ran.reached).eql([]);
  });
});
