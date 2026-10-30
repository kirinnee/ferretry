import type { Command } from 'commander';
import type { RenderController } from './controller.ts';

/** Mounts `fy render …` (docs/fy-render.md § Guide for agents). `guide` is the default verb. */
export function registerRenderCommands(program: Command, controller: RenderController): void {
  const render = program
    .command('render')
    .description('the fy-render authoring guide: the fence grammar, or one type’s section');

  render
    .command('guide', { isDefault: true })
    .description('print the guide: the fence grammar and the types, or one type’s section')
    .argument('[type]', 'mermaid, svg, html, chart, map, image, video, audio, pdf, lottie')
    .action((type: string | undefined) => {
      controller.guideFor(type);
    });
}
