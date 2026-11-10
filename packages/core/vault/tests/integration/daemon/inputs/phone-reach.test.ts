import { expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/kernel/contract';
import { err, ok } from '@ferretry/std';
import {
  type InputTargetAdapter,
  type InputTargetKind,
  PHONE_APPROVAL_UNAVAILABLE,
  type PhoneApprovalAsk,
  type PhoneApprovalProvider,
  type PushNumberRead,
} from '../../../../contract/index.ts';
import { FakeInputTarget } from '../../../../contract/testing/index.ts';
import { PhoneApprovalReach } from '../../../../daemon/adapters/inputs/phone-reach.ts';

const FERRET = 'f1' as FerretId;
const READ: PushNumberRead = { origin: 'https://login.okta.com', navigationId: 'n1', provider: 'okta' };

/** A page whose provider view the browser reads, remembering which page and ferret were asked about. */
class PageReading extends FakeInputTarget {
  readonly looked: unknown[][] = [];
  async pushNumber(ferret: FerretId, key: string) {
    this.looked.push([ferret, key]);
    return { pageId: 'page-1', read: READ };
  }
}

const providers =
  (found: Partial<Record<InputTargetKind, InputTargetAdapter>>) =>
  (kind: InputTargetKind): InputTargetAdapter | undefined =>
    found[kind];

const approvals = (raised: PhoneApprovalAsk[] = []): PhoneApprovalProvider => ({
  raise: async (_ferret, ask) => {
    raised.push(ask);
    return ok({ id: 'pa_0123456789abcdef01234567', state: 'waiting' });
  },
  agentView: async () => err('unused'),
});

test('the page look asks the page adapter for a provider’s view of the named page and nothing else', async () => {
  const page = new PageReading('page', 'login');
  const reach = new PhoneApprovalReach(providers({ page }), undefined, () => undefined);

  expect(await reach.pushNumber(FERRET, 'login')).toEqual({ pageId: 'page-1', read: READ });
  expect(page.looked).toEqual([[FERRET, 'login']]);
});

test('the page look finds nothing where no page adapter is bound or the adapter reads no number', async () => {
  const none = new PhoneApprovalReach(providers({}), undefined, () => undefined);
  const cannot = new PhoneApprovalReach(
    providers({ page: new FakeInputTarget('page', 'login') }),
    undefined,
    () => undefined,
  );

  expect(await none.pushNumber(FERRET, 'login')).toBeUndefined();
  expect(await cannot.pushNumber(FERRET, 'login')).toBeUndefined();
});

test('the terminal look observes the named terminal, and is unsupported where no terminal adapter is bound', async () => {
  const terminal = new FakeInputTarget('terminal', 'build');
  const seen = await new PhoneApprovalReach(providers({ terminal }), undefined, () => undefined).observeTerminal(
    FERRET,
    'build',
  );
  const absent = await new PhoneApprovalReach(providers({}), undefined, () => undefined).observeTerminal(
    FERRET,
    'build',
  );

  expect(seen.ok).toBe(true);
  expect(absent).toEqual({ ok: false, reason: 'unsupported' });
});

test('whether a ferret steered a surface is the observer’s answer, and with no observer every surface counts as steered', () => {
  const asked: unknown[][] = [];
  const observer = {
    tainted: (ferret: string, kind: 'browser' | 'terminal', since: number) => {
      asked.push([ferret, kind, since]);
      return kind === 'browser';
    },
  };
  const reach = new PhoneApprovalReach(providers({}), observer, () => undefined);

  expect(reach.tainted(FERRET, 'browser', 10)).toBe(true);
  expect(reach.tainted(FERRET, 'terminal', 20)).toBe(false);
  expect(asked).toEqual([
    [FERRET, 'browser', 10],
    [FERRET, 'terminal', 20],
  ]);
  const blind = new PhoneApprovalReach(providers({}), undefined, () => undefined);
  expect(blind.tainted(FERRET, 'browser', 10)).toBe(true);
  expect(blind.tainted(FERRET, 'terminal', 10)).toBe(true);
});

test('a raise is handed to whichever service provides approvals now, and refused in one fixed sentence when none does', async () => {
  const raised: PhoneApprovalAsk[] = [];
  let provider: PhoneApprovalProvider | undefined;
  const reach = new PhoneApprovalReach(providers({}), undefined, () => provider);
  const ask: PhoneApprovalAsk = { target: { kind: 'browser', key: 'login' } };

  expect(await reach.raisePhoneApproval(FERRET, ask)).toEqual(err(PHONE_APPROVAL_UNAVAILABLE));
  provider = approvals(raised);
  expect(await reach.raisePhoneApproval(FERRET, ask)).toEqual(
    ok({ id: 'pa_0123456789abcdef01234567', state: 'waiting' }),
  );
  expect(raised).toEqual([ask]);
});
