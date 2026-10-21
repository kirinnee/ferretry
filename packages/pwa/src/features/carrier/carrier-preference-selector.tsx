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
 */

import { Check } from 'lucide-react';
import { useId } from 'react';
import { CARRIER_PREFERENCE_LABEL, CARRIER_PREFERENCES, type CarrierPreference } from '../../lib/carrier-preference.ts';
import { cn } from '../../lib/class-names.ts';

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
}

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
  if (preference === 'tunnel') return availability.tunnelNote;
  return undefined;
};

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
    </fieldset>
  );
}
