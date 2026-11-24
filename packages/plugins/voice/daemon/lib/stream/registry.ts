/** One stream per device and two per machine (design §3.1, admission), and one voice chat per ferret. */
const DEVICE_STREAMS = 1;
const MACHINE_STREAMS = 2;

export type Admission =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly code: 'device_busy' | 'machine_busy' };

/** Who holds which stream right now. In memory only: a stream is as long-lived as its socket. */
export class StreamRegistry {
  private readonly byDevice = new Map<string, number>();
  private total = 0;
  private readonly ferrets = new Set<string>();

  /** Whether a stream from this device would be taken, without taking it (so the upgrade can answer 429 first). */
  wouldAdmit(device: string): 'ok' | 'device_busy' | 'machine_busy' {
    if ((this.byDevice.get(device) ?? 0) >= DEVICE_STREAMS) return 'device_busy';
    return this.total >= MACHINE_STREAMS ? 'machine_busy' : 'ok';
  }

  admit(device: string): Admission {
    const verdict = this.wouldAdmit(device);
    if (verdict !== 'ok') return { ok: false, code: verdict };
    this.byDevice.set(device, (this.byDevice.get(device) ?? 0) + 1);
    this.total += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.total -= 1;
        const left = (this.byDevice.get(device) ?? 1) - 1;
        if (left <= 0) this.byDevice.delete(device);
        else this.byDevice.set(device, left);
      },
    };
  }

  /** The one voice chat a ferret may have; `undefined` while another stream holds it. */
  claimFerret(ferret: string): (() => void) | undefined {
    if (this.ferrets.has(ferret)) return undefined;
    this.ferrets.add(ferret);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.ferrets.delete(ferret);
    };
  }
}
