/** What the person has chosen so far, one entry per question, in question order. */
export interface AnswerState {
  readonly picks: readonly (readonly string[])[];
  readonly others: readonly string[];
  readonly otherSelected: readonly boolean[];
}

/** The part of a form worth keeping while the person steps through it or the screen remounts. */
export interface QuestionDraft {
  readonly answers: AnswerState;
  readonly step: number;
}

export const initialAnswers = (count: number): AnswerState => ({
  picks: Array.from({ length: count }, () => []),
  others: Array.from({ length: count }, () => ''),
  otherSelected: Array.from({ length: count }, () => false),
});

export const answered = (state: AnswerState, index: number): boolean =>
  state.otherSelected[index] ? (state.others[index] ?? '').trim() !== '' : (state.picks[index]?.length ?? 0) > 0;

export const allAnswered = (state: AnswerState, count: number): boolean =>
  Array.from({ length: count }, (_, index) => answered(state, index)).every(Boolean);

/** The answer as the person reads it back on the review page; `null` while the question is open. */
export const answerText = (state: AnswerState, index: number): string | null => {
  if (!answered(state, index)) return null;
  return state.otherSelected[index] ? (state.others[index] ?? '').trim() : (state.picks[index] ?? []).join(', ');
};

export const toggleOption = (state: AnswerState, index: number, label: string, multiple: boolean): AnswerState => {
  const picks = state.picks.map(values => [...values]);
  const current = picks[index] ?? [];
  picks[index] = multiple
    ? current.includes(label)
      ? current.filter(value => value !== label)
      : [...current, label]
    : [label];
  const otherSelected = [...state.otherSelected];
  otherSelected[index] = false;
  return { ...state, picks, otherSelected };
};

export const selectOther = (state: AnswerState, index: number): AnswerState => {
  const picks = state.picks.map(values => [...values]);
  picks[index] = [];
  const otherSelected = [...state.otherSelected];
  otherSelected[index] = true;
  return { ...state, picks, otherSelected };
};

export const updateOther = (state: AnswerState, index: number, value: string): AnswerState => {
  const others = [...state.others];
  others[index] = value;
  return { ...state, others };
};

/** The drafts a browser tab keeps before the oldest is let go; far above any one person's open asks. */
const MAX_QUESTION_DRAFTS = 20;

/**
 * Unsent answers, kept for the life of the page and keyed by the exact question they belong to — daemon,
 * session and tool-use id — so a remount or reconnect resumes the form where the person left it, and a
 * same-named session on another daemon never inherits it. Memory only: an answer nobody sent is not
 * worth surviving a reload, and nothing here is a secret worth writing to disk.
 */
export class QuestionDraftStore {
  readonly #drafts = new Map<string, QuestionDraft>();

  load(key: string): QuestionDraft | undefined {
    return this.#drafts.get(key);
  }

  save(key: string, draft: QuestionDraft): void {
    this.#drafts.delete(key);
    this.#drafts.set(key, draft);
    for (const oldest of this.#drafts.keys()) {
      if (this.#drafts.size <= MAX_QUESTION_DRAFTS) break;
      this.#drafts.delete(oldest);
    }
  }

  clear(key: string): void {
    this.#drafts.delete(key);
  }
}

export const questionDrafts = new QuestionDraftStore();

/** One stable key per question, from its own text — a repeated question gets a numbered suffix. */
export const questionKeys = (toolUseId: string, texts: readonly string[]): readonly string[] => {
  const seen = new Map<string, number>();
  return texts.map(text => {
    const nth = (seen.get(text) ?? 0) + 1;
    seen.set(text, nth);
    return `${toolUseId}:${text}:${nth}`;
  });
};
