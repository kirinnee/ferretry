import { ENTRY_LEASE_MS } from '../../../contract/index.ts';

/** One stream per device and two per machine (design §3.1, admission), and one voice chat per ferret. */
const MACHINE_STREAMS = 2;

export type Admission =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly code: 'device_busy' | 'machine_busy' };

/** Who holds which stream right now. In memory only: a stream is as long-lived as its socket. */
export class StreamRegistry {
  private readonly devices = new Set<string>();
  private readonly ferrets = new Set<string>();
  /** Per ferret, until when its entry claim stands. */
  private readonly entries = new Map<string, number>();

  /** Whether a stream from this device would be taken, without taking it (so the upgrade can answer 429 first). */
  wouldAdmit(device: string): 'ok' | 'device_busy' | 'machine_busy' {
    if (this.devices.has(device)) return 'device_busy';
    return this.devices.size >= MACHINE_STREAMS ? 'machine_busy' : 'ok';
  }

  admit(device: string): Admission {
    const verdict = this.wouldAdmit(device);
    if (verdict !== 'ok') return { ok: false, code: verdict };
    this.devices.add(device);
    return { ok: true, release: () => void this.devices.delete(device) };
  }

  /**
   * THE CHAT'S ENTRY CLAIM. Voice mode tells a ferret once, however many tabs, devices or engines (the machine's stream, or a
   * phone's own speech) take part: the first caller finds no live claim and is the one that sends; everyone after it, until the
   * claim lapses, finds it live and sends nothing. Every call renews the claim, so one that anybody still holds never lapses
   * under them; one nobody renews for {@link ENTRY_LEASE_MS} is gone, and the next voice mode tells the ferret afresh.
   */
  enterVoice(ferret: string, nowMs: number): boolean {
    for (const [held, until] of this.entries) if (until <= nowMs) this.entries.delete(held);
    const live = this.entries.has(ferret);
    this.entries.set(ferret, nowMs + ENTRY_LEASE_MS);
    return !live;
  }

  /** Gives the claim up (the entry message was refused), so the next to enter sends it instead. */
  leaveVoice(ferret: string): void {
    this.entries.delete(ferret);
  }

  /** The one voice chat a ferret may have; `undefined` while another stream holds it. */
  claimFerret(ferret: string): (() => void) | undefined {
    if (this.ferrets.has(ferret)) return undefined;
    this.ferrets.add(ferret);
    return () => void this.ferrets.delete(ferret);
  }
}
