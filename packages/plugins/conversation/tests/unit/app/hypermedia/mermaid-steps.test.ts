/**
 * THE STEPS OF A STEPPED MERMAID DIAGRAM (`app/hypermedia/mermaid-steps.ts`; U1 review, item 3): where each `%% @step <title>` step ends, and
 * the source a step is drawn from: the head, every line up to the end of the step, and no marker line. Pure text in, text out.
 */
import { describe, expect, it } from 'bun:test';
import { MOST_MERMAID_STEPS, mermaidSteps, stepSource } from '../../../../app/hypermedia/mermaid-steps.ts';
import { heldFenceParseBlocks, holdFences } from '../../../../app/hypermedia/held-fence-parse.ts';

const FENCE = '`'.repeat(3);
const BODY = [
  'flowchart LR',
  '%% @step First arrow',
  '  A --> B',
  '%% @step Second arrow',
  '  B --> C',
  '  C --> D',
].join('\n');

describe('mermaidSteps', () => {
  it('finds a step at every marker, titled by the text after it, each ending where the next begins', () => {
    expect(mermaidSteps(BODY)).toEqual([
      { title: 'First arrow', end: 3 },
      { title: 'Second arrow', end: 6 },
    ]);
  });

  it('is no steps for a diagram with none, or with one: a lone marker is a comment', () => {
    expect(mermaidSteps('flowchart LR\n  A --> B')).toEqual([]);
    expect(mermaidSteps('flowchart LR\n%% @step Only\n  A --> B')).toEqual([]);
  });

  it('reads a marker with spaces around it, trims the title and allows an empty one', () => {
    expect(mermaidSteps('flowchart LR\n  %%   @step    One  \n  A --> B\n%%@step\n  B --> C')).toEqual([
      { title: 'One', end: 3 },
      { title: '', end: 5 },
    ]);
  });

  it('does not take another comment, or a marker mid-line, for a step', () => {
    expect(mermaidSteps('flowchart LR\n%% a note @step x\n  A --> B %% @step y\n%% @steps z\n  B --> C')).toEqual([]);
  });

  it(`is no steps at all past ${MOST_MERMAID_STEPS} markers, and every step at ${MOST_MERMAID_STEPS}`, () => {
    const many = (count: number): string =>
      ['flowchart LR', ...Array.from({ length: count }, (_, at) => `%% @step s${at}\n  N${at} --> N${at + 1}`)].join(
        '\n',
      );
    expect(mermaidSteps(many(MOST_MERMAID_STEPS)).length).toBe(MOST_MERMAID_STEPS);
    expect(mermaidSteps(many(MOST_MERMAID_STEPS + 1))).toEqual([]);
  });
});

describe('stepSource', () => {
  const steps = mermaidSteps(BODY);

  it('is the head and the lines of the step so far, with no marker line: step k builds on step k-1', () => {
    expect(stepSource(BODY, steps[0] as never)).toBe('flowchart LR\n  A --> B');
    expect(stepSource(BODY, steps[1] as never)).toBe('flowchart LR\n  A --> B\n  B --> C\n  C --> D');
  });
});

describe('the parser says where the steps are', () => {
  // The parser half of the mermaid host block, for one message whose text names no other fence.
  const read = (body: string): { readonly body: string; readonly steps?: unknown } => {
    const mermaid = heldFenceParseBlocks(holdFences(`${FENCE}mermaid\n${body}\n${FENCE}`)).find(
      each => each.name === 'mermaid',
    );
    return (mermaid?.parse?.({ body, attrs: {}, line: 1 }) ?? { body: '' }) as { body: string; steps?: unknown };
  };

  it('puts the steps in the mermaid block’s data, and none in a diagram with fewer than two', () => {
    expect(read(BODY).steps).toEqual([
      { title: 'First arrow', end: 3 },
      { title: 'Second arrow', end: 6 },
    ]);
    expect('steps' in read('flowchart LR\n  A --> B')).toBe(false);
  });

  it('drops a directive line before it counts the steps, so the end of a step is a line of the body it is drawn from', () => {
    const data = read(
      [
        '%%{init: {"securityLevel": "loose"}}%%',
        'flowchart LR',
        '%% @step One',
        '  A --> B',
        '%% @step Two',
        '  B --> C',
      ].join('\n'),
    );
    expect(data.body).not.toContain('init');
    expect(data.steps).toEqual([
      { title: 'One', end: 3 },
      { title: 'Two', end: 5 },
    ]);
    const steps = data.steps as readonly { title: string; end: number }[];
    expect(stepSource(data.body, steps[1] as never)).toBe('flowchart LR\n  A --> B\n  B --> C');
  });
});
