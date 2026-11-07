import { type DoctorReport, DoctorReportSchema } from '../contract/doctor.ts';
import type { DoctorLine } from './host.ts';

/** Today's sentence (`daemon/src/lib/core/doctor.ts`): what a presence report does and does not prove. */
const LIMITATION =
  "Resolving a program and stating that this host could run it is all this report proves — nothing here was launched but `tmux -V` and one version question to this daemon's own tmux server. It does not prove a harness is signed in, has credit, or can reach its provider.";

const impactOf = (line: DoctorLine): string =>
  line.fix ??
  (line.state === 'ok'
    ? 'Nothing is affected.'
    : line.state === 'warn'
      ? 'Ferretry keeps working, with less than it could do.'
      : 'Ferretry cannot rely on this until it is resolved.');

/**
 * `GET /v1/doctor`'s body (today's {@link DoctorReport}) from the checks every plugin ran: a failing check is a
 * `required` thing that is `missing`, a warning an `optional` one, a passing one `present`. `ready` is "nothing
 * failed". The harness lists are Runtimes' to give; the kernel names none. Details are the checks' own sentences,
 * which never carry a secret (the doctor contract).
 */
export function doctorReport(lines: readonly DoctorLine[]): DoctorReport {
  return DoctorReportSchema.parse({
    checks: lines.map(line => ({
      name: line.check === undefined ? line.plugin : `${line.plugin}: ${line.check}`,
      requirement: line.state === 'fail' ? 'required' : 'optional',
      status: line.state === 'ok' ? 'present' : 'missing',
      summary: line.detail === '' ? 'No detail.' : line.detail,
      impact: impactOf(line),
    })),
    harnesses: [],
    ready: lines.every(line => line.state !== 'fail'),
    limitation: LIMITATION,
  });
}
