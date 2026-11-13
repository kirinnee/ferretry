import { afterEach, describe, expect, test } from 'bun:test';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import type { Question } from '../../../../contract/index.ts';
import { pendingQuestionOf, questionAnswerApi } from '../../../../app/questions/question-form.tsx';
import { QuestionRenderer, questionAskValue } from '../../../../app/questions/question-renderer.tsx';
import { fakeClient } from '../../../support/app/fake-client.ts';
import { withClient } from '../../../support/app/client.tsx';

const QUESTION: Question = {
  format: 1,
  toolUseId: 'toolu_1',
  header: 'Deploy',
  text: 'Ship it now?',
  options: [{ label: 'Yes' }, { label: 'Later', description: 'after the review' }],
  multiple: false,
  askedAt: '2026-11-07T10:00:00.000Z' as Question['askedAt'],
};

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

describe('the ask:question renderer', () => {
  test('reads the question itself, an ask ref, or the ask around it, with its ferret', () => {
    expect(questionAskValue(QUESTION)).toEqual({ question: QUESTION });
    expect(questionAskValue({ ref: QUESTION, ferret: 'f1' })).toEqual({ question: QUESTION, ferret: 'f1' });
    expect(questionAskValue({ source: { ref: QUESTION }, ferret: 'f1' })).toEqual({ question: QUESTION, ferret: 'f1' });
    expect(questionAskValue({ ref: { card: 'F1' } })).toBeUndefined();
    expect(questionAskValue(null)).toBeUndefined();
  });

  test('one daemon question reads as a one-step form', () => {
    expect(pendingQuestionOf(QUESTION)).toEqual({
      toolUseId: 'toolu_1',
      questions: [{ question: 'Ship it now?', header: 'Deploy', options: QUESTION.options, multiSelect: false }],
    });
  });

  test('a tabbed form reads as a form of every question it asked, in order', () => {
    const tabbed: Question = {
      ...QUESTION,
      more: [{ header: 'Region', text: 'Which region?', options: [{ label: 'eu' }, { label: 'us' }], multiple: true }],
    };
    expect(pendingQuestionOf(tabbed)).toEqual({
      toolUseId: 'toolu_1',
      questions: [
        { question: 'Ship it now?', header: 'Deploy', options: QUESTION.options, multiSelect: false },
        { question: 'Which region?', header: 'Region', options: [{ label: 'eu' }, { label: 'us' }], multiSelect: true },
      ],
    });
  });

  test('with no ferret it is the read-only card: an answer must name its ferret', async () => {
    view = await mount(withClient(fakeClient(), <QuestionRenderer value={QUESTION} />));
    expect(view.container.querySelector('.fy-question-card')).not.toBeNull();
    expect(view.container.querySelector('.fy-question-form')).toBeNull();
  });

  test('with its ferret it is the answer form, and Submit posts the answer as the person with its request id', async () => {
    const client = fakeClient({ 'POST /v1/ferrets/:ferretId/answer': () => ({ ok: true }) }, 'd1');
    view = await mount(withClient(client, <QuestionRenderer value={{ ref: QUESTION, ferret: 'f1' }} />));
    const form = must(view.container.querySelector('.fy-question-form'), 'the answer form');
    expect(form.getAttribute('data-daemon-id')).toBe('d1');
    const yes = must(form.querySelector<HTMLInputElement>('input[type="radio"]'), 'the first option');
    await interact(() => yes.click());
    const submit = must(form.querySelector<HTMLButtonElement>('.fy-question-submit'), 'the submit button');
    await interact(() => submit.click());
    for (let turn = 0; turn < 20 && client.calls.length === 0; turn += 1) await interact(() => Promise.resolve());
    const [call] = client.callsTo('POST /v1/ferrets/:ferretId/answer');
    expect(call?.params).toEqual({ ferretId: 'f1' });
    expect(call?.body).toEqual({
      toolUseId: 'toolu_1',
      labels: ['Yes'],
      answers: [{ kind: 'selection', labels: ['Yes'] }],
    });
    expect(call?.headers['x-fy-request-id']).toMatch(/^question:d1:f1:toolu_1:[0-9a-f]{32}$/u);
  });

  test('the answer api sends only the fields it was given', async () => {
    const client = fakeClient({ 'POST /v1/ferrets/:ferretId/answer': () => ({}) }, 'd1');
    await questionAnswerApi(client).answer('f2', 'toolu_2', [], 'my own words');
    expect(client.calls[0]).toMatchObject({
      params: { ferretId: 'f2' },
      body: { toolUseId: 'toolu_2', labels: [], other: 'my own words' },
      headers: {},
    });
  });
});
