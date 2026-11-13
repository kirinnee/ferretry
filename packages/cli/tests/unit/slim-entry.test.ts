import { describe, it } from 'bun:test';
import { TOOLS_SERVER_INSTRUCTIONS } from '@ferretry/plugin-runtimes/contract';
import should from 'should';
import { serveHalf, toolDoor } from '../../src/generated/slim.ts';
import { registry } from '../../src/generated/commands.ts';
import { surfacesOf, toolFactsBeforeContact } from '../../src/lib/client.ts';
import { entrySlice, mcpServeInvocation } from '../../src/lib/entry/route.ts';
import { toolSurfaces } from '../../src/lib/entry/tool-door.ts';

describe('entrySlice', () => {
  it('sends every `mcp serve` to the slim root, whatever else is on the line', () => {
    for (const args of [
      ['mcp', 'serve'],
      ['mcp', 'serve', 'extra'],
      ['mcp', 'serve', '--bogus'],
      // Refused there, not routed to a path that would honour it.
      ['--as-owner', 'mcp', 'serve'],
    ])
      should(entrySlice(args)).equal('mcp-serve');
  });

  it('reads --as-owner before the verb', () => {
    should(mcpServeInvocation(['mcp', 'serve'])).eql({ asOwner: false });
    should(mcpServeInvocation(['--as-owner', 'mcp', 'serve'])).eql({ asOwner: true });
  });

  it('leaves everything that does not connect, and every other verb, on the full path', () => {
    for (const args of [
      ['mcp', 'serve', '--help'],
      ['mcp', 'serve', '-h'],
      ['--help', 'mcp', 'serve'],
      ['--version', 'mcp', 'serve'],
      ['--bogus', 'mcp', 'serve'],
      ['mcp', 'ls'],
      ['mcp', 'check', 'serve'],
      ['mcp'],
      ['serve'],
      [],
      ['terminal', 'ls'],
    ])
      should(entrySlice(args)).equal('full');
  });
});

describe('the tool door the slim root reads', () => {
  const full = surfacesOf(registry);
  const slim = toolSurfaces(toolDoor);

  it('holds the contract hash and title of every package the registry does', () => {
    should(slim.compiled).eql(full.compiled);
    should(slim.titles).eql(full.titles);
  });

  it('holds exactly the tool facts the registry’s manifests declare, in the same order', () => {
    should([...slim.tools]).eql([...full.tools]);
    should(slim.tools.size).be.above(0);
  });

  it('answers a tool by name as the full surfaces do, a refusal included', () => {
    for (const inPane of [true, false])
      for (const name of ['terminal_open', 'card_progress', 'no_such_tool'] as const) {
        const outcome = (surfaces: typeof full): string => {
          try {
            return JSON.stringify(toolFactsBeforeContact(surfaces, inPane, name));
          } catch (error) {
            return `refused: ${(error as Error).message}`;
          }
        };
        should(outcome(slim)).equal(outcome(full));
      }
  });

  it('carries the serve half’s version and its one-line instructions from their owners', async () => {
    should(serveHalf.version).equal(registry.plugins.find(plugin => plugin.id === 'mcp')?.manifest.version);
    should(await serveHalf.instructions()).equal(TOOLS_SERVER_INSTRUCTIONS);
    should(typeof (await serveHalf.load())).equal('function');
  });
});
