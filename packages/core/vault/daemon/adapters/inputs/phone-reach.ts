import type { FerretId } from '@ferretry/kernel/contract';
import { err, type Result } from '@ferretry/std';
import {
  type InputTargetAdapter,
  type InputTargetKind,
  type ObserveResult,
  PHONE_APPROVAL_UNAVAILABLE,
  type PhoneApprovalAgentView,
  type PhoneApprovalAsk,
  type PhoneApprovalProvider,
  type PushNumberRead,
  type VaultApi,
} from '../../../contract/index.ts';

/** The observer's own question, as the phone approval asks it (`LoginObserver.tainted`). */
interface Steering {
  tainted(sessionId: string, kind: 'browser' | 'terminal', since: number): boolean;
}

/**
 * WHAT ACCOUNTS' PHONE APPROVAL MAY LOOK AT, through the Vault (docs/input-requests.md, "Approve on your phone"): the
 * page's push number, the terminal's prompt, whether the ferret could have steered either, and the raise a request
 * tool hands on. Each is looked up on EVERY call (a Browsers or Accounts that was turned off since answers nothing),
 * and a missing adapter, observer or provider is a refusal, never a guess: no approval is raised on a look that cannot
 * be made. Nothing here reads an element a ferret points at (I201); the page adapter is asked for a provider's own view.
 */
export class PhoneApprovalReach
  implements Required<Pick<VaultApi, 'pushNumber' | 'observeTerminal' | 'tainted' | 'raisePhoneApproval'>>
{
  constructor(
    private readonly provider: (kind: InputTargetKind) => InputTargetAdapter | undefined,
    private readonly steering: Steering | undefined,
    private readonly phone: () => PhoneApprovalProvider | undefined,
  ) {}

  async pushNumber(
    ferret: FerretId,
    key: string,
  ): Promise<{ readonly pageId: string; readonly read: PushNumberRead } | undefined> {
    return await this.provider('page')?.pushNumber?.(ferret, key);
  }

  async observeTerminal(ferret: FerretId, key: string): Promise<ObserveResult> {
    const terminal = this.provider('terminal');
    if (terminal === undefined) return { ok: false, reason: 'unsupported' };
    return await terminal.observe(ferret, { kind: 'terminal', key }, []);
  }

  /** Without an observer nothing can be said NOT to be steered: every surface counts as steered. */
  tainted(ferret: FerretId, kind: 'browser' | 'terminal', since: number): boolean {
    return this.steering === undefined ? true : this.steering.tainted(ferret, kind, since);
  }

  async raisePhoneApproval(ferret: FerretId, ask: PhoneApprovalAsk): Promise<Result<PhoneApprovalAgentView, string>> {
    const provider = this.phone();
    return provider === undefined ? err(PHONE_APPROVAL_UNAVAILABLE) : await provider.raise(ferret, ask);
  }
}
