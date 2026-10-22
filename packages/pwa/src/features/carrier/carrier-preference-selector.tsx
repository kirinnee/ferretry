/**
 * THE CONNECTION PREFERENCE FOR ONE MACHINE — Auto, WebRTC only, Tunnel only or Relay only
 * (`docs/relay-protocol.md` §15 "The choice").
 *
 * One labelled radio group, used in two places so the two cannot drift: Settings › This device lists
 * every paired machine with one of these, and the machine's Connection status carries one for itself.
 * Both write the same per-device, per-machine value, and the router walks whatever it says.
 *
 * AN OPTION THAT CANNOT CARRY ANYTHING RIGHT NOW IS STILL OFFERED, AND SAYS WHY. §15 makes a preference
 * that leaves nothing to try a STATED failure, never a silent fall back, so hiding the option would
 * hide the very sentence a person needs: the note under it is what they would otherwise have to choose
 * it to discover.
 *
 * A TUNNEL IS OPT-IN PER MACHINE (§15), so choosing one that would walk it — Tunnel only, or Auto — for a
 * machine whose tunnel is switched off asks, once, whether to turn it on. Saying no keeps the choice: Auto
 * simply walks the other carriers, and Tunnel only says why it has nothing to try.
 */

import { Check } from 'lucide-react';
import { useId, useState } from 'react';
import { CARRIER_PREFERENCE_LABEL, CARRIER_PREFERENCES, type CarrierPreference } from '../../lib/carrier-preference.ts';
import { cn } from '../../lib/class-names.ts';
import type { TunnelSwitchState } from '../../lib/tunnel-switch.ts';
import { Button } from '../../shell/primitives.tsx';

/** What each preference does, in one line. WebRTC's says the relay only introduces — §15's own words. */
export const CARRIER_PREFERENCE_DESCRIPTION: Readonly<Record<CarrierPreference, string>> = {
  auto: 'Direct first, then WebRTC, then a Cloudflare tunnel, then a relay — whichever answers.',
  webrtc: 'Peer to peer. The relay is used only to introduce the two ends.',
  tunnel: 'Through this machine’s Cloudflare tunnel, and nothing else.',
  relay: 'Through a relay — the machine’s own, or Ferretry’s hosted one. The default.',
};

/** What a selector needs to know about one machine to say what each option would do. */
export interface CarrierPreferenceAvailability {
  /** Whether this build can dial WebRTC at all. */
  readonly webrtc: boolean;
  /**
   * Why "Tunnel only" would carry nothing for this machine — "Not set up by the operator." or "This
   * machine has no tunnel yet." — or `undefined` when there is a tunnel to dial, or it is not known yet.
   */
  readonly tunnelNote?: string | undefined;
  /** What the machine says about its own tunnel switch, once it has said anything. */
  readonly tunnel?: TunnelSwitchOffer | undefined;
}

/** One machine's tunnel switch, as a selector offers it. */
export interface TunnelSwitchOffer {
  /** The daemon's one line about its tunnel — "Tunnel: off (opt-in) — turn on with …" when it is off. */
  readonly sentence: string;
  /** Whether the tunnel is switched off for this machine, which is the opt-in default. */
  readonly off: boolean;
  /** Turns the tunnel on. Rejects with the daemon's own sentence when it refuses. */
  readonly turnOn: () => Promise<void>;
}

/**
 * A machine's switch as a selector offers it, or nothing until the machine has answered — and nothing
 * for a daemon older than the switch, whose tunnel was never opt-in.
 */
export const tunnelSwitchOffer = (
  state: TunnelSwitchState | undefined,
  turnOn: () => Promise<unknown>,
): TunnelSwitchOffer | undefined =>
  state?.kind === 'known'
    ? {
        sentence: state.view.sentence,
        off: !state.view.enabled,
        turnOn: async () => {
          await turnOn();
        },
      }
    : undefined;

/** Asked when a preference that walks the tunnel is chosen for a machine whose tunnel is off. */
export const TUNNEL_OFFER_QUESTION = 'Turn on a Cloudflare tunnel for this machine?';

/** What saying yes does, and how to undo it. */
export const TUNNEL_OFFER_DETAIL =
  'Ferretry’s hosted service gives this machine its own Cloudflare hostname. Cloudflare carries the ' +
  'encrypted session and cannot read it. Turn it off again at the machine with fy daemon tunnel off.';

/** Said under Tunnel only for a machine whose tunnel is switched off. */
export const TUNNEL_OFF_NOTE = 'Off for this machine — tunnels are opt-in.';

/** The preferences that walk a tunnel, and so are worth turning one on for. */
const walksTunnel = (preference: CarrierPreference): boolean => preference === 'tunnel' || preference === 'auto';

/** Said under WebRTC only in a build with no dialer. */
export const WEBRTC_UNAVAILABLE_NOTE = 'WebRTC isn’t available in this build yet.';

export interface CarrierPreferenceSelectorProps {
  readonly value: CarrierPreference;
  readonly onChange: (preference: CarrierPreference) => void;
  readonly availability: CarrierPreferenceAvailability;
  /** The group's visible name: "Connection preference", or the machine's name in a list of machines. */
  readonly legend: string;
  /** Visually hide the legend where a heading already names the group. */
  readonly legendHidden?: boolean;
}

const noteFor = (preference: CarrierPreference, availability: CarrierPreferenceAvailability): string | undefined => {
  if (preference === 'webrtc' && !availability.webrtc) return WEBRTC_UNAVAILABLE_NOTE;
  if (preference === 'tunnel') return availability.tunnel?.off === true ? TUNNEL_OFF_NOTE : availability.tunnelNote;
  return undefined;
};

/**
 * "Turn on a Cloudflare tunnel for this machine?" — asked under the group, never as a modal: the choice
 * is already made and kept, and this is only whether to give it a tunnel to walk.
 */
function TunnelOffer({ offer }: { readonly offer: TunnelSwitchOffer }) {
  const id = useId();
  const [phase, setPhase] = useState<'asking' | 'working' | 'dismissed'>('asking');
  const [error, setError] = useState<string | undefined>(undefined);
  if (phase === 'dismissed') return null;
  const turnOn = async (): Promise<void> => {
    setPhase('working');
    setError(undefined);
    try {
      await offer.turnOn();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPhase('asking');
    }
  };
  return (
    <section
      aria-labelledby={`${id}-question`}
      data-tunnel-offer=""
      className="flex min-w-0 flex-col gap-1 rounded-control border border-border bg-surface-2 px-control-x py-2 sm:col-span-2"
    >
      <p id={`${id}-question`} className="m-0 text-ui font-semibold text-fg">
        {TUNNEL_OFFER_QUESTION}
      </p>
      <p className="m-0 text-meta leading-tight text-muted">{TUNNEL_OFFER_DETAIL}</p>
      {error === undefined ? null : (
        <p role="alert" className="m-0 text-meta leading-tight text-err" data-tunnel-offer-error="">
          {error}
        </p>
      )}
      <div className="mt-1 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="primary"
          size="sm"
          className="min-h-[44px]"
          disabled={phase === 'working'}
          onClick={() => void turnOn()}
        >
          {phase === 'working' ? 'Turning on…' : 'Turn on'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-[44px]"
          disabled={phase === 'working'}
          onClick={() => setPhase('dismissed')}
        >
          Not now
        </Button>
      </div>
    </section>
  );
}

export function CarrierPreferenceSelector({
  value,
  onChange,
  availability,
  legend,
  legendHidden = false,
}: CarrierPreferenceSelectorProps) {
  // One name per group: two machines' groups on one page must not share a radio set.
  const name = useId();
  return (
    <fieldset
      className="m-0 grid min-w-0 grid-cols-1 gap-2 border-0 p-0 sm:grid-cols-2"
      data-carrier-preference={value}
    >
      <legend className={legendHidden ? 'sr-only' : 'mb-1 text-ui font-semibold text-fg'}>{legend}</legend>
      {CARRIER_PREFERENCES.map(preference => {
        const checked = preference === value;
        const note = noteFor(preference, availability);
        const noteId = `${name}-${preference}-note`;
        return (
          <label
            key={preference}
            data-carrier-preference-option={preference}
            className={cn(
              'flex min-h-[52px] min-w-0 cursor-pointer flex-col items-start justify-center gap-0.5 rounded-control border px-control-x py-2 text-left transition-colors has-[:focus-visible]:outline-focus has-[:focus-visible]:outline-offset-focus',
              checked
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-border bg-surface-2 text-fg hover:border-accent',
            )}
          >
            <input
              type="radio"
              name={name}
              value={preference}
              checked={checked}
              onChange={() => onChange(preference)}
              className="sr-only"
              {...(note === undefined ? {} : { 'aria-describedby': noteId })}
            />
            <span className="flex w-full items-center gap-2 text-ui font-semibold">
              {CARRIER_PREFERENCE_LABEL[preference]}
              {checked ? <Check size={14} className="ml-auto shrink-0" aria-hidden="true" /> : null}
            </span>
            <span className="text-meta leading-tight text-muted">{CARRIER_PREFERENCE_DESCRIPTION[preference]}</span>
            {note === undefined ? null : (
              <span id={noteId} className="text-meta leading-tight text-warn" data-carrier-preference-note="">
                {note}
              </span>
            )}
          </label>
        );
      })}
      {availability.tunnel?.off === true && walksTunnel(value) ? <TunnelOffer offer={availability.tunnel} /> : null}
    </fieldset>
  );
}
