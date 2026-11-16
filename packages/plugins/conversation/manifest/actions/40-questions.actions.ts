/** A ferret asking you mid-turn, and your answer: the two question routes, the app's Answer, the events and the asks it hears. */
import { appAction, route } from '@ferretry/kernel/manifest';
import { AskAnswered, AsksChanged } from '@ferretry/core-asks/contract';
import { cap, QUESTION_ANSWERED_AUDIT, QuestionAnswered, QuestionAsked } from '../../contract/index.ts';
import { ACK, FERRET, FLEET_USE, fragment, PERSON, READ, SECRETS } from '../kit.ts';

export default fragment({
  routes: [
    route('GET /v1/ferrets/:ferretId/question', { ...FERRET, ...FLEET_USE, ...READ, ...SECRETS }),
    route('POST /v1/ferrets/:ferretId/answer', {
      ...PERSON,
      // DELIBERATE PARITY CORRECTION: v4 declared no capability here (R-0335 `capability=none`). On 5.0 the route
      // types native keys and pastes into a pane, so a remote caller needs the terminal grant like
      // every other route that types (composer, permission, dialog). A local owner is still exempt.
      capability: cap('terminal', 'use'),
      audit: { record: QUESTION_ANSWERED_AUDIT },
      ...ACK,
    }),
  ],
  app: [appAction('question.answer', { on: 'ask', label: 'Answer', calls: 'POST /v1/ferrets/:ferretId/answer' })],
  data: { publishes: [QuestionAsked, QuestionAnswered], subscribes: [AskAnswered, AsksChanged] },
});
