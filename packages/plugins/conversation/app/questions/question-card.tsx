import { Check, CircleHelp } from 'lucide-react';
import './questions.css';

/**
 * One question a question tool asked, as the transcript card shows it (the chat's `readAskedQuestions` reads these out
 * of a tool call and its result; that reader is the transcript's).
 */
interface AskedQuestion {
  readonly header?: string;
  readonly question: string;
  readonly options: readonly { readonly label: string; readonly description?: string }[];
  readonly multiSelect: boolean;
  /** The owner's answer, when the result names it; `undefined` while open or unreadable. */
  readonly answer?: string;
}

export interface QuestionCardProps {
  readonly questions: readonly AskedQuestion[];
}

/**
 * A question the agent asked, in the transcript. Open until its result arrives; answered after,
 * from the transcript alone, so a reload shows the same thing. Answering happens in the form above
 * the composer, never here — this card is the record.
 */
export function QuestionCard({ questions }: QuestionCardProps) {
  const open = questions.some(item => item.answer === undefined);
  return (
    <section
      aria-label={open ? 'Question awaiting your answer' : 'Answered question'}
      className="fy-question-card"
      data-state={open ? 'open' : 'answered'}
    >
      <p className="fy-eyebrow">
        {open ? <CircleHelp aria-hidden="true" size={12} /> : <Check aria-hidden="true" size={12} />}{' '}
        {open ? 'Waiting for your answer' : 'Answered'}
      </p>
      {questions.map(item => (
        <div className="fy-question-card-item" key={item.question}>
          {item.header ? <strong>{item.header}</strong> : null}
          <p>{item.question}</p>
          <ul aria-label="Options">
            {item.options.map(option => (
              <li data-chosen={item.answer?.includes(option.label) ? '' : undefined} key={option.label}>
                <span>{option.label}</span>
                {option.description ? <small>{option.description}</small> : null}
              </li>
            ))}
          </ul>
          {item.multiSelect ? <small>Pick one or more</small> : null}
          {item.answer === undefined ? null : (
            <p className="fy-question-card-answer">
              <span>Your answer</span> {item.answer}
            </p>
          )}
        </div>
      ))}
    </section>
  );
}
