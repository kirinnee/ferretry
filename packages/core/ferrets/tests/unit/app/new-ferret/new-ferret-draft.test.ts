import { describe, expect, it } from 'bun:test';
import {
  buildStartBody,
  canStartFerret,
  emptyNewFerretDraft,
  type NewFerretDraft,
  startFerret,
} from '../../../../app/features/new-ferret/new-ferret-draft.ts';
import { type Call, scripted } from '../support/client.ts';

const draft = (overrides: Partial<NewFerretDraft> = {}): NewFerretDraft => ({
  ...emptyNewFerretDraft,
  runtime: 'claude-a',
  folder: '/work/a',
  prompt: 'Go',
  ...overrides,
});

describe('canStartFerret', () => {
  it('needs a runtime, a folder and — in auto mode — a prompt', () => {
    expect(canStartFerret(emptyNewFerretDraft, false)).toBeFalse();
    expect(canStartFerret(draft(), false)).toBeTrue();
    expect(canStartFerret(draft({ runtime: '  ' }), false)).toBeFalse();
    expect(canStartFerret(draft({ folder: ' ' }), false)).toBeFalse();
    expect(canStartFerret(draft({ prompt: ' ' }), false)).toBeFalse();
  });

  it('lets an interactive ferret start bare, and nothing start twice', () => {
    expect(canStartFerret(draft({ mode: 'interactive', prompt: '' }), false)).toBeTrue();
    expect(canStartFerret(draft(), true)).toBeFalse();
  });
});

describe('buildStartBody', () => {
  it('trims text, drops blanks and sends the options flat as the daemon parses them', () => {
    expect(
      buildStartBody(
        draft({
          runtime: ' claude-a ',
          folder: ' /work/a ',
          model: ' opus ',
          label: ' site ',
          prompt: ' Go ',
          fast: true,
          remoteControl: true,
        }),
      ),
    ).toEqual({
      runtime: 'claude-a',
      folder: '/work/a',
      model: 'opus',
      mode: 'auto',
      fast: true,
      remoteControl: true,
      label: 'site',
      prompt: 'Go',
    });
  });

  it('sends fast and Remote Control only when they were asked for', () => {
    const body = buildStartBody(draft({ model: '', label: '' }));
    expect(body).toEqual({ runtime: 'claude-a', folder: '/work/a', mode: 'auto', prompt: 'Go' });
    expect(body).not.toHaveProperty('fast');
    expect(body).not.toHaveProperty('remoteControl');
  });

  it('refuses a body the daemon would refuse: a runtime that is not a name, or no folder', () => {
    expect(() => buildStartBody(draft({ runtime: 'Not A Runtime!' }))).toThrow();
    expect(() => buildStartBody(draft({ folder: '' }))).toThrow();
  });
});

describe('startFerret', () => {
  it('posts the body through the route key and answers the new ferret’s id', async () => {
    const calls: Call[] = [];
    const id = await startFerret(scripted({ 'POST /v1/ferrets': { id: 'f9' } }, calls), draft());
    expect(id).toBe('f9');
    expect(calls).toEqual([
      {
        route: 'POST /v1/ferrets',
        params: undefined,
        query: undefined,
        body: { runtime: 'claude-a', folder: '/work/a', mode: 'auto', prompt: 'Go' },
      },
    ]);
  });

  it('lets a daemon refusal through with its own sentence, and refuses an answer with no id', async () => {
    await expect(startFerret(scripted({ 'POST /v1/ferrets': new Error('no such runtime') }), draft())).rejects.toThrow(
      'no such runtime',
    );
    await expect(startFerret(scripted({ 'POST /v1/ferrets': {} }), draft())).rejects.toThrow();
  });
});
