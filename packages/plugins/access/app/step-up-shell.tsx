/**
 * ACCESS'S PASSKEY PROMPT, HANDED TO THE SHELL (G95, G105; `@ferretry/app`'s `PasskeyProvision`).
 *
 * Today's app store built two `StepUpGate`s — the step-up (`403 grant_step_up_required`) and the unlock
 * (`401 unlock_required`) — and gave the carrier router two hooks that asked them on a refusal and resent the request
 * ONCE; `App.tsx` mounted one `StepUpDialog` for each, told both which machine was on screen, and named a machine apart
 * from its twins (`distinctDaemonName`). This is that wiring, moved: the shell's per-daemon client consults
 * {@link accessPasskey}'s handler on every refusal (so every plugin's call asks through the ONE prompt, and none has a
 * second), and the shell mounts its `Prompts` where every page is drawn.
 *
 * The ceremony rides Access's own guarded client (`lib/route-request.ts`): options, the operating system's passkey
 * sheet, the daemon's verdict. Nothing here holds a credential (G100): a verified step-up is a fact the daemon keeps
 * about this device and this copy of the app; no challenge or assertion is stored, and none is logged.
 */

import type {
  PairedDaemon,
  PasskeyAsk,
  PasskeyHandler,
  PasskeyNeed,
  PasskeyPorts,
  PasskeyProvision,
  PasskeyRefusal,
  PromptOrigin,
} from '@ferretry/app';
import {
  PasteRuleStageIdSchema,
  SignInRuleStageIdSchema,
  STEP_UP_REQUIRED_CODE,
  StepUpActSchema,
  StepUpRequiredBodySchema,
  TaskPlanStageIdSchema,
  TwoFactorStageIdSchema,
  UNLOCK_REQUIRED_CODE,
} from '@ferretry/core-gate/contract';
import { useCallback, useSyncExternalStore } from 'react';
import { z } from 'zod';
import { StepUpDialog, UNLOCK_COPY } from './features/step-up/step-up-dialog.tsx';
import { stepUpAct } from './lib/grants.ts';
import { routeRequestClient } from './lib/route-request.ts';
import {
  fetchSecuritySettings,
  stepUpStaysSentence,
  UNLOCK_STAYS_FALLBACK,
  unlockStaysSentence,
} from './lib/security-settings-client.ts';
import { describeStepUpFailure, firstPasskeyOffer, stepUpCeremony, unlockCeremony } from './lib/step-up-ceremony.ts';
import type { StepUpClient } from './lib/step-up-client.ts';
import { type PromptOrigin as GateOrigin, StepUpGate } from './lib/step-up-gate.ts';
import { type DaemonConnection, type DaemonId, daemonConnection, distinctDaemonName } from './shell-pairing.ts';

/** Said when the ceremony is asked for a machine this device cannot reach right now (no session, or Access paused). */
export const PASSKEY_UNREACHABLE =
  'This device cannot reach this machine right now, so it cannot confirm with a passkey.';

/** The staged thing a bound passkey is for, re-read from the shell's plain string (today's stage id schemas). */
const SubjectSchema = z.union([
  TwoFactorStageIdSchema,
  TaskPlanStageIdSchema,
  SignInRuleStageIdSchema,
  PasteRuleStageIdSchema,
]);

/** The refusal's machine code, read from a copy of its body; anything else reads as none. */
const codeOf = (body: unknown): unknown =>
  typeof body === 'object' && body !== null ? (body as { readonly code?: unknown }).code : undefined;

/**
 * Whether a refusal is a passkey need, and which (today's `answersWithCode` + `stepUpDemand`). The unlock is a `401`
 * with its code; a step-up is a `403` with its body, whose demand names the act — or, when the demand does not parse,
 * a step-up that still asks and says "this change". `not-granted`, `undetermined` and every other refusal are not a
 * passkey need and raise nothing (G108).
 */
export function passkeyNeed(refusal: PasskeyRefusal): PasskeyNeed | undefined {
  if (refusal.status === 401) return codeOf(refusal.body) === UNLOCK_REQUIRED_CODE ? { kind: 'unlock' } : undefined;
  if (refusal.status !== 403) return undefined;
  const named = StepUpRequiredBodySchema.safeParse(refusal.body);
  if (named.success) {
    const { demand } = named.data;
    return { kind: 'step-up', act: stepUpAct(demand), ...(demand.act === undefined ? {} : { actId: demand.act }) };
  }
  return codeOf(refusal.body) === STEP_UP_REQUIRED_CODE ? { kind: 'step-up' } : undefined;
}

/** A paired daemon as the gates and the prompt name it. */
const connectionOf = (daemon: PairedDaemon): DaemonConnection =>
  daemonConnection({
    daemonId: daemon.daemon,
    baseUrl: daemon.address,
    deviceId: daemon.deviceId,
    daemonName: daemon.machine,
  });

/** A pairing as `distinctDaemonName` reads it: its name, its label, its address and the day it was made. */
const namedPairing = (daemon: PairedDaemon) => ({
  ...connectionOf(daemon),
  ...(daemon.label === undefined ? {} : { label: daemon.label }),
  pairedAt: daemon.pairedAt,
});

/** What the shell's origin is in the gate's words (the same two values). */
const gateOrigin = (origin: PromptOrigin): GateOrigin => origin;

/**
 * Builds the step-up gate and the unlock gate over Access's own client, the handler the shell's client consults, and
 * the two prompts. Copied from today's `createAppStore` (`stepUp`, `unlockGate`) and `App.tsx` (the two dialogs).
 */
export function accessPasskey(ports: PasskeyPorts): PasskeyProvision {
  const client = async (daemon: DaemonConnection): Promise<StepUpClient> => {
    const routed = ports.client(daemon.daemonId);
    if (routed === undefined) throw new Error(PASSKEY_UNREACHABLE);
    return routeRequestClient(routed);
  };
  const ceremonyPorts = { client, credentials: ports.credentials, origin: ports.origin };
  const stepUp = new StepUpGate({
    // The client is read only when a person presses the prompt's button.
    ceremony: stepUpCeremony(ceremonyPorts),
    describe: describeStepUpFailure(ports.origin),
    // The machine's own window, read once as the prompt opens; a failed read leaves the prompt's neutral words.
    scope: async daemon => {
      const view = await fetchSecuritySettings(await client(daemon));
      return stepUpStaysSentence(view.settings.stepUpWindowMinutes);
    },
  });
  const unlockGate = new StepUpGate({
    ceremony: unlockCeremony(ceremonyPorts),
    describe: describeStepUpFailure(ports.origin),
    // A device with no passkey, inside its window, is offered to set one up rather than sent elsewhere.
    firstPasskey: firstPasskeyOffer(client),
    // The machine's own number, read once as the prompt opens (an exempt route, so it answers before an unlock).
    scope: async daemon => {
      try {
        const view = await fetchSecuritySettings(await client(daemon));
        return unlockStaysSentence(view.settings.unlockValidityHours);
      } catch {
        return UNLOCK_STAYS_FALLBACK;
      }
    },
  });

  const handler: PasskeyHandler = {
    need: passkeyNeed,
    confirm: async (daemon, need, origin) => {
      const connection = connectionOf(daemon);
      if (need.kind === 'unlock') return await unlockGate.require(connection, undefined, gateOrigin(origin));
      const actId = need.actId === undefined ? undefined : StepUpActSchema.safeParse(need.actId);
      return await stepUp.require(
        connection,
        need.act,
        gateOrigin(origin),
        actId?.success === true ? actId.data : undefined,
      );
    },
    ask: async (daemon: PairedDaemon, request: PasskeyAsk) => {
      // A bound ask the gate cannot stamp is refused here, never asked unbound: the save would refuse it anyway.
      const actId = request.actId === undefined ? undefined : StepUpActSchema.safeParse(request.actId);
      if (actId?.success === false || (actId === undefined && request.subject !== undefined)) return false;
      const subject = request.subject === undefined ? undefined : SubjectSchema.safeParse(request.subject);
      if (subject?.success === false) return false;
      return await stepUp.require(
        connectionOf(daemon),
        request.act,
        'explicit',
        actId?.data,
        subject?.data,
        request.words,
      );
    },
    focus: daemon => {
      const onScreen = daemon as DaemonId | null;
      stepUp.focus(onScreen);
      unlockGate.focus(onScreen);
    },
    locked: () => unlockGate.waitingDaemons(),
    subscribe: listener => unlockGate.subscribe(listener),
  };

  function Prompts() {
    const snapshot = useSyncExternalStore(ports.daemons.subscribe, ports.daemons.snapshot, ports.daemons.snapshot);
    // G95: a prompt names WHICH machine is asking, told apart from a twin by its address.
    const machineName = useCallback(
      (daemonId: string): string => {
        const paired = snapshot.daemons.map(namedPairing);
        const record = paired.find(candidate => candidate.daemonId === daemonId);
        return record === undefined ? 'This machine' : distinctDaemonName(record, paired);
      },
      [snapshot],
    );
    return (
      <>
        {/* One passkey prompt for the whole app: any daemon request refused for want of a step-up raises it. */}
        <StepUpDialog gate={stepUp} machineName={machineName} />
        {/* The same prompt, for a machine that asks for a passkey on opening (`unlock_required`). */}
        <StepUpDialog gate={unlockGate} copy={UNLOCK_COPY} machineName={machineName} />
      </>
    );
  }

  return { handler, Prompts };
}
