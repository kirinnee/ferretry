import { describe, it } from 'bun:test';
import should from 'should';
import { RenderCommandError, RenderController } from '../../../src/lib/render/controller';
import { RENDER_GUIDE_TYPES } from '../../../src/lib/render/guide';
import { RENDER_GUIDE_SECTION } from '../../../src/lib/render/guide-text';
import { FakeRenderOutput } from './fixtures';

function subject(guide: string = RENDER_GUIDE_SECTION, bin = 'fy') {
  const out = new FakeRenderOutput();
  return { controller: new RenderController(out, bin, guide), out };
}

describe('RenderController', () => {
  it('should print the overview and one guide command per type when no type is given', () => {
    // Arrange
    const { controller, out } = subject(undefined, 'fy');

    // Act
    controller.guideFor(undefined);

    // Assert
    should(out.text).startWith('Write a fenced block whose info string is exactly');
    for (const type of RENDER_GUIDE_TYPES) {
      should(out.text).containEql(`\nfy render guide ${type}`);
    }
  });

  it('should print one type’s section for the types the hypermedia prompt names', () => {
    // Act + Assert — triangulated: the line each type lost from the prompt is its first line
    const { controller, out } = subject();
    for (const [type, firstLine] of [
      ['chart', 'JSON/YAML {kind: bar, x: [Mon, Tue], y: {format: money}, series: [{name: Cost, data: [2, 3]}]};'],
      [
        'map',
        'JSON/YAML {center: [lat, lng], zoom, markers: [{at, label, popup}], lines: [{points}], polygons, geojson}; real places.',
      ],
      ['image', 'save files you make into $FY_MEDIA_DIR'],
    ] as const) {
      controller.guideFor(type);
      should(out.text).startWith(firstLine);
    }
  });

  it('should print the same media section for image, video, audio and pdf', () => {
    // Arrange
    const { controller, out } = subject();
    const printed: string[] = [];

    // Act
    for (const type of ['image', 'video', 'audio', 'pdf']) {
      controller.guideFor(type);
      printed.push(out.text);
    }

    // Assert
    should(printed[0]).startWith('save files you make into $FY_MEDIA_DIR');
    should(printed[1]).equal(printed[0]);
    should(printed[2]).equal(printed[0]);
    should(printed[3]).equal(printed[0]);
  });

  it('should carry the facts the prompt lines left out: chart tones, map caps, media bounds', () => {
    // Arrange
    const { controller, out } = subject();

    // Act + Assert
    controller.guideFor('chart');
    should(out.text).containEql('No colours: tone accent|good|warn|bad|muted|1-8.');
    controller.guideFor('map');
    should(out.text).containEql('zoom` is 0–18');
    controller.guideFor('pdf');
    should(out.text).containEql('at most 1 MiB');
  });

  it('should refuse an unknown type with the list', () => {
    // Arrange
    const { controller } = subject();

    // Act + Assert
    should(() => controller.guideFor('diagram')).throw(
      new RenderCommandError(`no type diagram — one of ${RENDER_GUIDE_TYPES.join(', ')}`),
    );
  });

  it('should refuse when the shipped guide has lost the section it was asked for', () => {
    // Arrange — a guide text without the subsection, so the refusal is reachable
    const { controller } = subject('## Guide for agents\n\n### overview\nonly the overview\n');

    // Act + Assert
    should(() => controller.guideFor('chart')).throw(
      new RenderCommandError(
        'the shipped guide has no ### chart section — docs/fy-render.md § Guide for agents and packages/cli/src/lib/render/guide-text.ts disagree',
      ),
    );
  });

  it('should refuse when the shipped guide is empty at a section heading', () => {
    // Arrange — an empty body reads as empty, not missing, and is refused all the same
    const { controller } = subject('## Guide for agents\n### chart\n### map\na shape\n');

    // Act + Assert
    should(() => controller.guideFor('chart')).throw(
      new RenderCommandError(
        'the shipped guide has no ### chart section — docs/fy-render.md § Guide for agents and packages/cli/src/lib/render/guide-text.ts disagree',
      ),
    );
  });

  it('should speak the binary’s own name in the per-type commands', () => {
    // Arrange
    const { controller, out } = subject(RENDER_GUIDE_SECTION, 'renamed');

    // Act
    controller.guideFor(undefined);

    // Assert
    should(out.text).containEql('\nrenamed render guide chart');
  });
});
