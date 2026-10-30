import { describe, it } from 'bun:test';
import should from 'should';
import {
  RENDER_GUIDE_HEADING,
  RENDER_GUIDE_TYPES,
  renderGuideSection,
  renderGuideSectionName,
} from '../../../src/lib/render/guide';
import { RENDER_GUIDE_SECTION } from '../../../src/lib/render/guide-text';

/** A minimal guide in the shipped shape, so boundaries are asserted against a known text. */
const doc = [
  'intro before the guide',
  '',
  RENDER_GUIDE_HEADING,
  '',
  '### overview',
  'the fence grammar',
  '',
  '### chart',
  'the chart shape',
  'a second line',
  '',
  '### media',
  'the media shape',
  '',
  '---',
  '',
  '## Declared gaps',
  'after the guide',
].join('\n');

describe('renderGuideSection', () => {
  it('should read one subsection body, trimmed', () => {
    // Act
    const actual = renderGuideSection(doc, 'chart');

    // Assert
    should(actual).equal('the chart shape\na second line');
  });

  it('should read the first and the last subsection as well as a middle one', () => {
    // Act + Assert — triangulated: a middle section could pass by luck
    should(renderGuideSection(doc, 'overview')).equal('the fence grammar');
    should(renderGuideSection(doc, 'media')).equal('the media shape');
  });

  it('should end a body at a ### line wherever it lands, the boundary rule being shape alone', () => {
    // Arrange — a payload line that looks like a heading is still read as one: the doc owns the
    // shape, and prose in the shipped section never begins a line with ###
    const input = [RENDER_GUIDE_HEADING, '### svg', 'first line', '### looks like a heading', 'second line'].join('\n');

    // Act + Assert
    should(renderGuideSection(input, 'svg')).equal('first line');
  });

  it('should read an empty body as empty, for the caller to refuse', () => {
    // Arrange
    const input = [RENDER_GUIDE_HEADING, '### svg', '### chart', 'the chart shape'].join('\n');

    // Act + Assert
    should(renderGuideSection(input, 'svg')).equal('');
  });

  it('should refuse a name the guide has no subsection for', () => {
    // Act + Assert
    should(renderGuideSection(doc, 'nope')).be.undefined();
  });

  it('should refuse when the guide heading itself is not there', () => {
    // Arrange
    const input = '### chart\nthe chart shape\n';

    // Act + Assert
    should(renderGuideSection(input, 'chart')).be.undefined();
  });

  it('should read every section of the shipped guide', () => {
    // Arrange — every type, plus the overview the bare command prints
    const names = ['overview', 'mermaid', 'svg', 'html', 'chart', 'map', 'media', 'lottie'];

    // Act + Assert
    for (const name of names) {
      should(renderGuideSection(RENDER_GUIDE_SECTION, name)).not.be.empty();
    }
  });
});

describe('renderGuideSectionName', () => {
  it('should map each type to its section, with the four media types sharing one', () => {
    // Act + Assert — triangulated across the whole closed set
    should(renderGuideSectionName('mermaid')).equal('mermaid');
    should(renderGuideSectionName('svg')).equal('svg');
    should(renderGuideSectionName('html')).equal('html');
    should(renderGuideSectionName('chart')).equal('chart');
    should(renderGuideSectionName('map')).equal('map');
    should(renderGuideSectionName('image')).equal('media');
    should(renderGuideSectionName('video')).equal('media');
    should(renderGuideSectionName('audio')).equal('media');
    should(renderGuideSectionName('pdf')).equal('media');
    should(renderGuideSectionName('lottie')).equal('lottie');
  });

  it('should refuse a type the guide does not know', () => {
    // Act + Assert
    should(renderGuideSectionName('diagram')).be.undefined();
    should(renderGuideSectionName('')).be.undefined();
  });

  it('should name a section for every type the command lists', () => {
    // Act + Assert — the list the bare guide prints and the map can never drift
    for (const type of RENDER_GUIDE_TYPES) {
      should(renderGuideSectionName(type)).be.a.String();
    }
  });
});
