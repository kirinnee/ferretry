/**
 * The browser entry for "the form could not be read safely": the REAL `QuestionForm`, answered once against a daemon
 * whose reply is the `answer_form_unreadable` refusal (fixed fake data: a deploy question and the daemon's own sentence).
 *
 *   ?theme=<family>-<mode>
 *
 * The scene answers by itself (the first option, then Send) so a screenshot shows the form the way a person sees it after
 * the refusal: the sentence that says what happened and where to answer, the Console button, and the technical Details.
 */
import { createRoot } from 'react-dom/client';
import { DaemonCallError } from '@ferretry/app';
import { QuestionForm } from '../../../../app/questions/question-form.tsx';
import { QuestionDraftStore } from '../../../../app/questions/question-form-model.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const SENTENCE =
  "Couldn't read this question's form safely, so nothing was sent. Answer it at the terminal (the Console tab).";

const api = {
  answer: async (): Promise<never> => {
    throw new DaemonCallError(409, 'answer_form_unreadable', SENTENCE, {
      error: SENTENCE,
      detail: 'the form cursor is not visible exactly once; nothing further was typed',
    });
  },
};

createRoot(document.getElementById('root') as HTMLElement).render(
  <main style={{ boxSizing: 'border-box', margin: '0 auto', maxWidth: 560, padding: 16 }}>
    <QuestionForm
      api={api}
      daemon="daemon-a"
      drafts={new QuestionDraftStore()}
      ferretId="ferret-a"
      onOpenConsole={() => undefined}
      question={{
        toolUseId: 'toolu_scene',
        questions: [{ question: 'Deploy to staging?', options: [{ label: 'Yes' }, { label: 'No' }] }],
      }}
    />
  </main>,
);
