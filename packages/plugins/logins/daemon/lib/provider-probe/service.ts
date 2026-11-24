import type { Credential } from '../shared/credential.ts';
import type { ProviderPreset } from '../presets/schema.ts';
import type { LoginId, LoginTestCode, LoginTestResult } from '../../../contract/index.ts';
import type { AuthorizedOutcome } from '@ferretry/core-vault/contract';
import { planProviderProbe, type ProviderProbePlan } from './plan.ts';
import type { ProviderProbeClock, ProviderProbePort } from './ports.ts';
import type { ModelListReadNote } from '../model-lists/audit.ts';

/**
 * A person's **Test** of an environment login (docs/provider-presets.md): one request, the cheapest
 * the provider allows, to prove the key works — and a code and a fixed sentence back, never the
 * provider's body.
 *
 * A TEST NEVER SPENDS WITHOUT BEING ASKED. A provider with a free authenticated read (a model list, a
 * balance) is tested with that. A provider with none is tested with one message capped at one output
 * token, and only when the request carries the person's consent (`allowInference`); without it the
 * answer is `consent_required` and nothing is sent.
 */

/** One fixed sentence per code. */
const PROVIDER_TEST_MESSAGES: Readonly<Record<LoginTestCode, string>> = {
  ok: 'The provider accepted this login.',
  not_set: 'A secret this login needs is not in the secret store. Paste it and store it first.',
  rejected: 'The provider refused this key. Check it was copied whole, or make a new one.',
  rate_limited: 'The provider is rate limiting or busy right now. Try again in a minute.',
  timeout: 'The provider did not answer in time. Try again.',
  unreachable: 'This machine could not reach the provider. Check the address and the network connection.',
  provider_error: 'The provider answered with an error. Check the address and the model, then try again.',
  malformed: 'The provider answered with something unexpected.',
  vault_damaged: 'This machine’s secret store cannot be read, so the key could not be used.',
  consent_required:
    'This provider has no free check, so the Test sends one message capped at one token. Confirm to send it.',
  not_testable: 'This login cannot be tested here.',
  refused: 'The Test was not sent.',
};

/** What an outcome proved about the login. */
export function probeCode(outcome: AuthorizedOutcome): LoginTestCode {
  switch (outcome.kind) {
    case 'completion':
    case 'oversized':
      return 'ok';
    case 'unreadable':
      return 'malformed';
    case 'secret_missing':
      return 'not_set';
    case 'vault_damaged':
      return 'vault_damaged';
    case 'timeout':
      return 'timeout';
    case 'unreachable':
      return 'unreachable';
    case 'refused':
      return 'refused';
    default:
      if (outcome.status === 401 || outcome.status === 403) return 'rejected';
      if (outcome.status === 429 || outcome.status === 529) return 'rate_limited';
      return 'provider_error';
  }
}

export interface ProviderProbeServiceParts {
  readonly probe: ProviderProbePort;
  readonly clock: ProviderProbeClock;
  /**
   * A Test that asked a model list is about to be sent: the function that takes the body it gets, to be kept as ids. It
   * is asked for BEFORE the request, so the login it speaks for is the one the request was made under. The body is the
   * provider's reply and is never logged or returned; the callee reads the ids and drops it. Neither may throw.
   */
  readonly modelListRecorder?: (loginId: string) => (payload: unknown) => Promise<void>;
  /**
   * A keyed read of a model list put the login's key on a request: say so (the `secrets.used` record). Metadata only: the
   * login, the secret's name, the host and the outcome's kind. Must not throw.
   */
  readonly onListRead?: (note: ModelListReadNote) => Promise<void>;
}

/** The outcomes of a keyed read that put the key on no request. */
const NOTHING_SENT: ReadonlySet<string> = new Set(['refused', 'secret_missing', 'vault_damaged']);

/** A model list is asked at a path ending `/models` (every provider's list endpoint); a quota or key read is not one. */
const MODEL_LIST_PATH = /\/models\/?$/u;

/** Whether a plan is one free read of a model list. */
const asksModelList = (plan: ProviderProbePlan): boolean =>
  plan.kind === 'authorized' && plan.spends === 'nothing' && MODEL_LIST_PATH.test(new URL(plan.request.url).pathname);

/** One login to test: its id, what it is, and the preset it was made from. */
export interface ProviderProbeSubject {
  readonly id: string;
  readonly credential: Credential;
  readonly preset: ProviderPreset | undefined;
}

export class ProviderProbeService {
  constructor(private readonly parts: ProviderProbeServiceParts) {}

  async test(subject: ProviderProbeSubject, consent: { readonly allowInference: boolean }): Promise<LoginTestResult> {
    const started = this.parts.clock.monotonicMs();
    const result = (
      code: LoginTestCode,
      spent: LoginTestResult['spent'],
      message = PROVIDER_TEST_MESSAGES[code],
      sent = false,
    ): LoginTestResult => ({
      loginId: subject.id as LoginId,
      ok: code === 'ok',
      code,
      message,
      spent,
      ...(sent ? { latencyMs: Math.max(0, this.parts.clock.monotonicMs() - started) } : {}),
      at: this.parts.clock.now(),
    });
    if (subject.credential.store !== 'environment') {
      return result(
        'not_testable',
        'nothing',
        'Only a login made from environment variables is tested here; use Check now for a sign-in.',
      );
    }
    if (subject.preset === undefined) {
      return result(
        'not_testable',
        'nothing',
        'This login was not made from a preset this machine has, so Ferretry does not know a safe way to test it.',
      );
    }
    const plan = planProviderProbe(subject.preset, subject.credential);
    if ('reason' in plan) return result(plan.code, 'nothing', plan.reason);
    if (plan.spends === 'one-token' && !consent.allowInference) return result('consent_required', 'nothing');
    const record = asksModelList(plan) ? this.parts.modelListRecorder?.(subject.id) : undefined;
    const outcome = await this.parts.probe.probe(plan);
    const code = probeCode(outcome);
    // The Test of a provider whose Test IS its model list keeps the ids from that same reply: no second request.
    if (outcome.kind === 'completion' && record !== undefined) await record(outcome.payload).catch(() => undefined);
    // A refusal, a missing secret or a damaged store sent nothing; anything else reached the provider.
    const sent = !['refused', 'not_set', 'vault_damaged'].includes(code);
    return result(code, sent ? plan.spends : 'nothing', PROVIDER_TEST_MESSAGES[code], sent);
  }

  /**
   * The model-list reply of an environment login whose Test is a free read of the provider's model list: the parsed body,
   * for the list service to read the ids from. `undefined` for every login that has no such read (a sign-in, a preset
   * with no key, a Test that is a quota read or an inference, a refusal), and for any answer that is not a 2xx body: the
   * caller keeps the list it had. Nothing is spent, and the body goes no further than the caller.
   */
  async listModels(subject: ProviderProbeSubject): Promise<{ readonly payload: unknown } | 'failed' | undefined> {
    if (subject.credential.store !== 'environment' || subject.preset === undefined) return undefined;
    const plan = planProviderProbe(subject.preset, subject.credential);
    if ('reason' in plan || !asksModelList(plan)) return undefined;
    const outcome = await this.parts.probe.probe(plan);
    // The Vault placed the key on that request (or refused before it did): say so, by name and host, once per read. A
    // refusal, a missing secret or a damaged store put nothing on a request and writes nothing.
    if (plan.kind === 'authorized' && !NOTHING_SENT.has(outcome.kind)) {
      await this.parts
        .onListRead?.({
          loginId: subject.id,
          secret: String(plan.secretName),
          host: new URL(plan.request.url).host,
          outcome: outcome.kind,
        })
        .catch(() => undefined);
    }
    return outcome.kind === 'completion' ? { payload: outcome.payload } : 'failed';
  }
}
