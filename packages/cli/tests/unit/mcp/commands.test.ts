import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerMcpCommands } from '../../../src/lib/mcp/commands';

describe('fy mcp serve', () => {
  it('should start the server and nothing else', async () => {
    let served = 0;
    const program = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerMcpCommands(program, async () => {
      served += 1;
    });
    await program.parseAsync(['node', 'fy', 'mcp', 'serve']);
    should(served).equal(1);
  });
});
