import { describe, expect, it } from 'bun:test';
import { lessonsParts } from '../../daemon/launch-parts.ts';

type Instruction = { readonly kind: 'instruction'; readonly id: string; readonly text: string };
const ids = (parts: readonly unknown[]): string[] => (parts as Instruction[]).map(part => part.id);
const spec = (ferret: string) => ({ ferret, name: ferret }) as never;

describe('what Lessons adds to a launch', () => {
  it('adds the Global document to every launch, and the teaching only to a ferret that is instructed', async () => {
    const source = lessonsParts(
      { passive: async ferret => ferret === 'learner', global: async () => '- Use bun.\n' },
      'fy',
    );
    const learner = await source.parts(spec('learner'));
    expect(ids(learner)).toEqual(['lessons-global', 'lessons']);
    expect((learner[1] as Instruction | undefined)?.text).toContain('fy lesson suggest');
    expect(ids(await source.parts(spec('other')))).toEqual(['lessons-global']);
  });

  it('adds nothing before the first Apply to a ferret that is not instructed', async () => {
    const source = lessonsParts({ passive: async () => false, global: async () => undefined }, 'fy');
    expect(await source.parts(spec('f'))).toEqual([]);
    const blank = lessonsParts({ passive: async () => false, global: async () => '  \n' }, 'fy');
    expect(await blank.parts(spec('f'))).toEqual([]);
  });
});
