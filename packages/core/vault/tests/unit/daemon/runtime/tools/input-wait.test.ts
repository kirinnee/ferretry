import { describe, it } from 'bun:test';
import { ferretStanding } from '@ferretry/core-gate/contract/testing';
import type { CallContext, FerretId } from '@ferretry/kernel/contract';
import should from 'should';
import { err, ok } from '@ferretry/std';
import {
  PHONE_APPROVAL_UNAVAILABLE,
  type PhoneApprovalAgentView,
  type PhoneApprovalProvider,
} from '../../../../../contract/index.ts';
import { InputRequestError } from '../../../../../daemon/lib/inputs/errors.ts';
import type { InputRequestService } from '../../../../../daemon/lib/inputs/service.ts';
import type { InputAgentView } from '../../../../../daemon/lib/inputs/wire.ts';
import { inputTools } from '../../../../../daemon/lib/runtime/tools/input-wait.ts';

const FERRET = 'ferret-1' as FerretId;
const callOf = (): CallContext => ({ ...ferretStanding(FERRET) }) as unknown as CallContext;

/** A service whose `agentView` answers `view` (or throws), remembering what the tool asked. */
function serviceAnswering(answer: Partial<InputAgentView> | Error) {
  const asked: { ferret: string; id: string; waitMs: number }[] = [];
  const service = {
    agentView: async (ferret: string, id: string, waitMs: number) => {
      asked.push({ ferret, id, waitMs });
      if (answer instanceof Error) throw answer;
      return { id, ...answer, observed: { thing: 'only the daemon saw' } } as unknown as InputAgentView;
    },
  } as unknown as InputRequestService;
  return { service, asked };
}

const waitFor = async (answer: Partial<InputAgentView>, input: unknown = { id: '!A7' }) => {
  const { service } = serviceAnswering(answer);
  return await inputTools(service).input_wait(callOf(), input);
};

describe('the input_wait tool: where a card stands, in words', () => {
  it('I17 should tell a ferret its card still waits, and that the owner’s value is being typed', async () => {
    should((await waitFor({ state: 'pending' })).text).equal(
      '!A7 is still waiting for the owner. Wait again with input.wait; do not type there yourself.',
    );
    should((await waitFor({ state: 'delivering' })).text).equal(
      "!A7: the owner's value is being typed now. Wait again with input.wait.",
    );
  });

  it('I17 should say what a delivery was and whether Enter was pressed, for a typed value and a secure copy', async () => {
    should((await waitFor({ state: 'delivered', submitted: true })).text).equal(
      '!A7: the owner typed the value and pressed Enter. Read the terminal to see what happened.',
    );
    should((await waitFor({ state: 'delivered', submitted: false })).text).equal(
      '!A7: the owner typed the value. Read the terminal to see what happened.',
    );
    should((await waitFor({ state: 'delivered', source: 'sealed', submitted: true })).text).equal(
      '!A7: the secure copy was pasted and Enter pressed. Read the terminal once its quarantine allows.',
    );
    should((await waitFor({ state: 'delivered', source: 'sealed' })).text).equal(
      '!A7: the secure copy was pasted. Read the terminal once its quarantine allows.',
    );
  });

  it('I17 should say a card was refused, expired or cancelled, with the reason only when there is one', async () => {
    should((await waitFor({ state: 'refused', reason: 'target_changed' })).text).equal(
      '!A7 was refused (target_changed): the value was not typed. Look at the terminal, then raise a new request if it is still needed.',
    );
    should((await waitFor({ state: 'refused' })).text).equal(
      '!A7 was refused: the value was not typed. Look at the terminal, then raise a new request if it is still needed.',
    );
    should((await waitFor({ state: 'expired' })).text).equal('!A7 expired without an answer.');
    should((await waitFor({ state: 'cancelled', reason: 'owner_declined' })).text).equal(
      '!A7 was cancelled (owner_declined).',
    );
    should((await waitFor({ state: 'cancelled' })).text).equal('!A7 was cancelled.');
  });

  it('I17 should never hand a ferret what the daemon observed', async () => {
    const answer = await waitFor({ state: 'pending' });

    should(answer.data).not.have.property('observed');
    should(answer.isError).be.undefined();
  });
});

describe('the input_wait tool: what it asks and refuses', () => {
  it('I17 should accept a card id with or without the bang and wait ten seconds unless told otherwise', async () => {
    const { service, asked } = serviceAnswering({ state: 'pending' });
    const tools = inputTools(service);

    await tools.input_wait(callOf(), { id: '!A7' });
    await tools.input_wait(callOf(), { id: 'A8', timeoutMs: 2_500 });

    should(asked).eql([
      { ferret: FERRET, id: 'A7', waitMs: 10_000 },
      { ferret: FERRET, id: 'A8', waitMs: 2_500 },
    ]);
  });

  it('I17 should refuse a call that is not a ferret’s own', async () => {
    const { service, asked } = serviceAnswering({ state: 'pending' });
    const owner = {
      actor: 'admin-cli',
      credential: { kind: 'authenticated', tokenClass: 'admin' },
    } as unknown as CallContext;

    const answer = await inputTools(service).input_wait(owner, { id: 'A7' });

    should(answer.isError).be.true();
    should(asked).eql([]);
  });

  it('I17 should refuse an id that is not a card, a wait outside the bounds and any unknown field, asking nothing', async () => {
    const { service, asked } = serviceAnswering({ state: 'pending' });
    const tools = inputTools(service);

    for (const input of [
      { id: 'nope' },
      { id: 'A7', timeoutMs: 50 },
      { id: 'A7', timeoutMs: 60_000 },
      { id: 'A7', extra: 1 },
      {},
    ]) {
      const answer = await tools.input_wait(callOf(), input);
      should(answer.isError).be.true();
      should(answer.text).equal('input_wait takes a card id like !A7 and an optional timeoutMs');
    }
    should(asked).eql([]);
  });

  it('I17 should turn a service refusal into the tool’s refusal, and let any other failure through', async () => {
    const refused = serviceAnswering(new InputRequestError('not_found', 'no such card'));
    const broken = new Error('a genuine bug');

    const answer = await inputTools(refused.service).input_wait(callOf(), { id: 'A7' });
    const thrown = await inputTools(serviceAnswering(broken).service)
      .input_wait(callOf(), { id: 'A7' })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    should(answer).eql({ text: 'no such card', isError: true });
    should(thrown).equal(broken);
  });
});

describe('the input_wait tool: a phone approval is waited on through the service that provides it', () => {
  const PA = 'pa_0123456789abcdef01234567';

  /** A provider answering `answer` (or refusing), remembering who asked and for how long. */
  function providing(answer: PhoneApprovalAgentView | string) {
    const asked: { ferret: string; id: string; waitMs: number }[] = [];
    const provider: PhoneApprovalProvider = {
      raise: async () => err('not used'),
      agentView: async (ferret, id, waitMs) => {
        asked.push({ ferret, id, waitMs });
        return typeof answer === 'string' ? err(answer) : ok(answer);
      },
    };
    return { provider, asked };
  }
  const waitOn = async (provider: PhoneApprovalProvider | undefined, input: unknown = { id: PA }) => {
    const { service, asked } = serviceAnswering({ state: 'pending' });
    const answer = await inputTools(service, () => provider).input_wait(callOf(), input);
    return { answer, cardAsked: asked };
  };

  it('should hand a pa_ id to the approval service and never to an input card', async () => {
    const { provider, asked } = providing({ id: PA, state: 'waiting' });

    const { answer, cardAsked } = await waitOn(provider, { id: `!${PA}`, timeoutMs: 5_000 });

    should(asked).eql([{ ferret: FERRET, id: PA, waitMs: 5_000 }]);
    should(cardAsked).eql([]);
    should(answer.text).equal(
      `${PA} is still waiting for the owner to approve on their phone. Wait again with input_wait; do not act on that page or terminal meanwhile.`,
    );
  });

  it('should say where each approval stands and carry no number, account or anything else of the card', async () => {
    const said = async (view: PhoneApprovalAgentView) => await waitOn(providing(view).provider);

    should((await said({ id: PA, state: 'moved-on', secondFactor: 'push' })).answer.text).equal(
      `${PA}: the sign-in went through after a push. Read the page or terminal and carry on.`,
    );
    should((await said({ id: PA, state: 'moved-on' })).answer.text).equal(
      `${PA}: the sign-in moved on. Read the page or terminal to see where it is.`,
    );
    should((await said({ id: PA, state: 'timed-out' })).answer.text).equal(
      `${PA} ran out of time without the sign-in moving on. Ask again only if the site sent a new push.`,
    );
    should((await said({ id: PA, state: 'refused' })).answer.text).equal(
      `${PA}: the owner did not expect this sign-in and said "Not me". Stop signing in there and do not ask again.`,
    );
    const gone = await said({ id: PA, state: 'gone' });
    should(gone.answer.text).equal(`${PA} ended: the page or terminal closed.`);
    should(gone.answer.data).eql({ id: PA, state: 'gone' });
  });

  it('should refuse in one fixed sentence while no service provides approvals', async () => {
    const { answer, cardAsked } = await waitOn(undefined);

    should(answer).eql({ text: PHONE_APPROVAL_UNAVAILABLE, isError: true });
    should(cardAsked).eql([]);
  });

  it('should hand the service’s own refusal to the ferret as it is', async () => {
    const { answer } = await waitOn(providing('no phone approval pa_x in this session').provider);

    should(answer).eql({ text: 'no phone approval pa_x in this session', isError: true });
  });

  it('should refuse a pa_ id that is not 24 hex digits as it refuses any other bad id', async () => {
    const { provider, asked } = providing({ id: PA, state: 'waiting' });

    const { answer } = await waitOn(provider, { id: 'pa_short' });

    should(answer.isError).be.true();
    should(answer.text).equal('input_wait takes a card id like !A7 and an optional timeoutMs');
    should(asked).eql([]);
  });
});
