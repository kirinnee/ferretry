import type { LaunchPartSource } from '@ferretry/core-ferrets/contract';

/** The pane's agenda variable (read by `instructions` and the agenda prompt section): `1` told, `0` not told. */
export const AGENDA_ENV = 'FY_AGENDA';

/**
 * `launch.parts`: what a launch says about agenda mode. `FY_AGENDA` follows the switch recorded for the ferret (or the
 * machine default when none was), so the pane is told what every surface shows and Ferrets records it for `instructions`.
 */
export const agendaLaunchPart = (enabled: (ferret: string) => Promise<boolean>): LaunchPartSource => ({
  parts: async spec => [{ kind: 'env', env: { [AGENDA_ENV]: (await enabled(spec.ferret)) ? '1' : '0' } }],
});
