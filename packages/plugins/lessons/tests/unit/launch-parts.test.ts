import { describe, expect, it } from 'bun:test';
import { LESSONS_PASSIVE_ENV, lessonsParts } from '../../daemon/launch-parts.ts';

type Instruction = { readonly kind: 'instruction'; readonly id: string; readonly text: string };
const instructions = (parts: readonly unknown[]): Instruction[] =>
  (parts as { kind: string }[]).filter(part => part.kind === 'instruction') as Instruction[];
const ids = (parts: readonly unknown[]): string[] => instructions(parts).map(part => part.id);
const envOf = (parts: readonly unknown[]): unknown[] =>
  (parts as { kind: string; env?: unknown }[]).filter(part => part.kind === 'env').map(part => part.env);
const spec = (ferret: string) => ({ ferret, name: ferret }) as never;

describe('what Lessons adds to a launch', () => {
  it('adds the Global document to every launch, and the teaching only to a ferret that is instructed', async () => {
    const source = lessonsParts(
      { passive: async ferret => ferret === 'learner', global: async () => '- Use bun.\n' },
      'fy',
    );
    const learner = await source.parts(spec('learner'));
    expect(ids(learner)).toEqual(['lessons-global', 'lessons']);
    expect(instructions(learner)[1]?.text).toContain('fy lesson suggest');
    expect(ids(await source.parts(spec('other')))).toEqual(['lessons-global']);
  });

  it('adds nothing before the first Apply to a ferret that is not instructed', async () => {
    const source = lessonsParts({ passive: async () => false, global: async () => undefined }, 'fy');
    expect(instructions(await source.parts(spec('f')))).toEqual([]);
    const blank = lessonsParts({ passive: async () => false, global: async () => '  \n' }, 'fy');
    expect(instructions(await blank.parts(spec('f')))).toEqual([]);
  });

  it('lessons#0: every launch records FY_LEARNING_PASSIVE as 1 for an instructed ferret and 0 otherwise', async () => {
    expect(LESSONS_PASSIVE_ENV).toBe('FY_LEARNING_PASSIVE');
    const source = lessonsParts({ passive: async ferret => ferret === 'learner', global: async () => undefined }, 'fy');
    expect(envOf(await source.parts(spec('learner')))).toEqual([{ FY_LEARNING_PASSIVE: '1' }]);
    expect(envOf(await source.parts(spec('other')))).toEqual([{ FY_LEARNING_PASSIVE: '0' }]);
  });
});
