/** One stream per device and two per machine (design §3.1, admission), and one voice chat per ferret. */
const MACHINE_STREAMS = 2;

export type Admission =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly code: 'device_busy' | 'machine_busy' };

/** Who holds which stream right now. In memory only: a stream is as long-lived as its socket. */
export class StreamRegistry {
  private readonly devices = new Set<string>();
  private readonly ferrets = new Set<string>();

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

  /** The one voice chat a ferret may have; `undefined` while another stream holds it. */
  claimFerret(ferret: string): (() => void) | undefined {
    if (this.ferrets.has(ferret)) return undefined;
    this.ferrets.add(ferret);
    return () => void this.ferrets.delete(ferret);
  }
}
