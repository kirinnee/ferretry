import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerRenderCommands } from '../../../src/lib/render/commands';
import { RenderController } from '../../../src/lib/render/controller';
import { RENDER_GUIDE_SECTION } from '../../../src/lib/render/guide-text';
import { FakeRenderOutput } from './fixtures';

function run(argv: string[]) {
  const out = new FakeRenderOutput();
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerRenderCommands(program, new RenderController(out, 'fy', RENDER_GUIDE_SECTION));
  return { parsed: program.parseAsync(['node', 'fy', ...argv]), out };
}

describe('render command surface', () => {
  it('should print the overview when no verb or type is given', async () => {
    // Act
    const bare = run(['render']);
    await bare.parsed;

    // Assert
    should(bare.out.text).startWith('Write a fenced block whose info string is exactly');
    should(bare.out.text).containEql('\nfy render guide chart');

    const named = run(['render', 'guide']);
    await named.parsed;
    should(named.out.text).equal(bare.out.text);
  });

  it('should print one type’s section', async () => {
    // Act
    const chart = run(['render', 'guide', 'chart']);
    await chart.parsed;

    // Assert
    should(chart.out.text).startWith('JSON/YAML {kind: bar');
  });

  it('should refuse an unknown type, non-zero, with the list', async () => {
    // Act + Assert
    await should(run(['render', 'guide', 'diagram']).parsed).rejectedWith(/no type diagram — one of mermaid/);
  });

  it('should explain the guide in its help', () => {
    // Arrange
    const program = new Command().name('fy');
    registerRenderCommands(program, new RenderController(new FakeRenderOutput(), 'fy', RENDER_GUIDE_SECTION));

    // Act
    const help = program.commands.find(command => command.name() === 'render')?.helpInformation();

    // Assert
    should(help).containEql('authoring guide');
  });
});
