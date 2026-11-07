import { describe, it } from 'bun:test';
import should from 'should';
import { AnswerQuestionController, InterruptController } from '../../../cli/lib/answer/controller.ts';
import { planAnswer } from '../../../cli/lib/answer/plan.ts';
import { CompactAtController } from '../../../cli/lib/compact-at/controller.ts';
import { CommandError } from '../../../cli/lib/errors.ts';
import type { AnswerRequest, CompactAtPatch, FerretCompactAt } from '../../../contract/index.ts';

const out = (): { lines: string[]; out(line: string): void; note(line: string): void } => {
  const lines: string[] = [];
  return { lines, out: line => lines.push(line), note: line => lines.push(`note: ${line}`) };
};

describe('planAnswer', () => {
  it('should answer with labels against the named question', () => {
    should(planAnswer({ toolUseId: 'tool-1', labels: ['yes'] })).deepEqual({
      toolUseId: 'tool-1',
      labels: ['yes'],
    });
  });

  it('should drop blank labels rather than sending empty choices', () => {
    should(planAnswer({ toolUseId: 'tool-1', labels: ['  ', 'no'] }).labels).deepEqual(['no']);
  });

  it('should carry a free-form Other response and one response per question', () => {
    should(planAnswer({ toolUseId: 't', other: 'not yet' })).deepEqual({
      toolUseId: 't',
      labels: [],
      other: 'not yet',
    });
    should(planAnswer({ toolUseId: 't', responses: ['yes', 'no'] })).deepEqual({
      toolUseId: 't',
      labels: [],
      responses: ['yes', 'no'],
    });
  });

  it('should refuse an answer that chose nothing at all, and one that names no question', () => {
    should(() => planAnswer({ toolUseId: 't', labels: [' '] })).throw(/provide labels/);
    should(() => planAnswer({ labels: ['yes'] })).throw(/--question/);
  });
});

describe('answer and interrupt', () => {
  it('should send the plan to the gateway and say it was answered', async () => {
    const sent: AnswerRequest[] = [];
    const output = out();
    const gateway = {
      answer: async (_ferret: string, request: AnswerRequest) => void sent.push(request),
      interrupt: async () => undefined,
    };
    await new AnswerQuestionController(gateway, output).execute('hadi', { toolUseId: 't1', labels: ['yes'] });
    should(sent).deepEqual([{ toolUseId: 't1', labels: ['yes'] }]);
    should(output.lines).deepEqual(['hadi: answered']);
  });

  it('should interrupt and print JSON on request', async () => {
    const output = out();
    const called: string[] = [];
    const gateway = { answer: async () => undefined, interrupt: async (ferret: string) => void called.push(ferret) };
    await new InterruptController(gateway, output).execute('hadi', { json: true });
    should(called).deepEqual(['hadi']);
    should(JSON.parse(output.lines[0] ?? '')).deepEqual({ ferret: 'hadi', interrupted: true });
  });
});

describe('CompactAtController', () => {
  const reading: FerretCompactAt = { effective: 250_000, restartRequired: false, note: 'Takes effect now.' };
  const make = () => {
    const writes: CompactAtPatch[] = [];
    const gateway = {
      read: async () => reading,
      write: async (_ferret: string, change: CompactAtPatch) => {
        writes.push(change);
        return { effective: 250_000, restartRequired: true, note: 'Changed; applies at the next restart.' } as const;
      },
    };
    return { writes, gateway };
  };

  it('should read the current value, marking a default', async () => {
    const output = out();
    await new CompactAtController(make().gateway, output).run('hadi', undefined);
    should(output.lines[0]).match(/^compact at .*\(default\)$/);
    should(output.lines[1]).equal('Takes effect now.');
  });

  it('should set a size, auto or inherit, and say what the daemon said', async () => {
    const { writes, gateway } = make();
    const output = out();
    const controller = new CompactAtController(gateway, output);
    await controller.run('hadi', '250k');
    await controller.run('hadi', 'auto');
    await controller.run('hadi', 'INHERIT');
    should(writes).deepEqual([{ compactAt: 250_000 }, { compactAt: 'auto' }, { compactAt: 'inherit' }]);
    should(output.lines).have.length(3);
  });

  it('should refuse an unusable value and a blank ferret before calling the daemon', async () => {
    const { writes, gateway } = make();
    const controller = new CompactAtController(gateway, out());
    await controller.run('hadi', 'soon').then(
      () => should.fail(undefined, undefined, 'expected a refusal'),
      error => should(error).be.instanceOf(CommandError),
    );
    await controller.run('  ', undefined).then(
      () => should.fail(undefined, undefined, 'expected a refusal'),
      error => should(error.message).match(/name the ferret/),
    );
    should(writes).be.empty();
  });
});
