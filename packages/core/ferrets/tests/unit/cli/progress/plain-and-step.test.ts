import { expect, test } from 'bun:test';
import { PlainProgress } from '../../../../cli/lib/progress/plain.ts';
import type { IProgress } from '../../../../cli/lib/progress/ports.ts';
import { withStep } from '../../../../cli/lib/progress/step.ts';

const plain = (): { readonly progress: PlainProgress; readonly lines: string[] } => {
  const lines: string[] = [];
  return { progress: new PlainProgress(line => lines.push(line)), lines };
};

test('plain progress writes one line when a step begins and none for detail or pause', () => {
  const { progress, lines } = plain();
  progress.start('copying');
  progress.detail();
  progress.pause();
  expect(lines).toEqual(['- copying']);
});

test('plain progress says nothing when a step succeeds without text and a line when it has some', () => {
  const { progress, lines } = plain();
  progress.start('a');
  progress.succeed();
  progress.start('b');
  progress.succeed('b took a while');
  expect(lines).toEqual(['- a', '- b', '✔ b took a while']);
});

test('plain progress names the live step when it fails without text', () => {
  const { progress, lines } = plain();
  progress.start('copying');
  progress.fail();
  expect(lines).toEqual(['- copying', '✖ copying failed']);
});

test('plain progress prints the failure text it was given', () => {
  const { progress, lines } = plain();
  progress.start('copying');
  progress.fail('disk is full');
  expect(lines).toEqual(['- copying', '✖ disk is full']);
});

test('plain progress prints nothing for a failure with no live step and no text', () => {
  const { progress, lines } = plain();
  progress.fail();
  progress.start('copying');
  progress.stop();
  progress.fail();
  expect(lines).toEqual(['- copying']);
});

const events = (): { readonly progress: IProgress; readonly log: string[] } => {
  const log: string[] = [];
  return {
    log,
    progress: {
      start: label => void log.push(`start ${label}`),
      detail: () => undefined,
      succeed: () => void log.push('succeed'),
      fail: () => void log.push('fail'),
      pause: () => undefined,
      stop: () => undefined,
    },
  };
};

test('a step that returns is completed and hands back its result', async () => {
  const { progress, log } = events();
  expect(await withStep(progress, 'build', async () => 42)).toBe(42);
  expect(log).toEqual(['start build', 'succeed']);
});

test('a step that throws is failed and rethrows the same error', async () => {
  const { progress, log } = events();
  const boom = new Error('boom');
  await expect(
    withStep(progress, 'build', async () => {
      throw boom;
    }),
  ).rejects.toBe(boom);
  expect(log).toEqual(['start build', 'fail']);
});
