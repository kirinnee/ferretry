/**
 * The browser entry for "a pending question, folded": the REAL `QuestionDrawer` around the REAL `QuestionForm`, over
 * fixed fake data (a "Fix" question with three options), under a stand-in transcript and above a stand-in composer.
 * The Agenda's "Agenda · 2 need you" pill is another plugin's; here it is a stand-in button beside the line.
 *
 *   ?theme=<family>-<mode>
 */
import { createRoot } from 'react-dom/client';
import { QuestionDrawer, questionTopic } from '../../../../app/questions/question-drawer.tsx';
import { QuestionForm, type PendingQuestion } from '../../../../app/questions/question-form.tsx';
import { QuestionDraftStore } from '../../../../app/questions/question-form-model.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const question: PendingQuestion = {
  toolUseId: 'toolu_scene',
  questions: [
    {
      header: 'Fix',
      question: 'Which fix should I apply?',
      options: [
        { label: 'Patch the parser', description: 'Smallest change; keeps the old behaviour' },
        { label: 'Rewrite the reader', description: 'Cleaner, but touches more files' },
        { label: 'Leave it' },
      ],
    },
  ],
};

const api = { answer: async (): Promise<unknown> => ({ ok: true }) };

createRoot(document.getElementById('root') as HTMLElement).render(
  <main
    style={{
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      height: '100dvh',
      margin: '0 auto',
      maxWidth: 720,
      padding: 16,
    }}
  >
    <div style={{ flex: 1, overflow: 'hidden' }}>
      <p style={{ margin: '0 0 8px' }}>You: the parser drops the last line of a file. Can you look?</p>
      <p style={{ margin: 0 }}>Ferret: Found two ways to fix it. I need you to choose one before I go on.</p>
    </div>
    <button
      style={{ alignSelf: 'flex-start', border: '1px solid var(--border)', borderRadius: 999, padding: '4px 12px' }}
      type="button"
    >
      Agenda · 2 need you
    </button>
    <QuestionDrawer agentName="Alpha Ferret" label="Answer the ferret's questions" topic={questionTopic(question)}>
      <QuestionForm
        api={api}
        daemon="daemon-a"
        drafts={new QuestionDraftStore()}
        ferretId="ferret-a"
        question={question}
      />
    </QuestionDrawer>
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, color: 'var(--muted)', padding: 12 }}>
      Message Alpha Ferret…
    </div>
  </main>,
);
