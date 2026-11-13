import SCRIPT from '../../../../../scripts/host/ferretry-loopback-firewall' with { type: 'text' };
import VERIFY_UNIT from '../../../../../scripts/host/ferretry-loopback-firewall-verify.service' with { type: 'text' };
import TIMER from '../../../../../scripts/host/ferretry-loopback-firewall-verify.timer' with { type: 'text' };
import UNIT from '../../../../../scripts/host/ferretry-loopback-firewall.service' with { type: 'text' };
import type { FirewallFiles } from '../lib/verbs/index.ts';

/** The repository's host files, compiled into the binary so a brew or nix `fy` carries them without a checkout. */
export const BUNDLED_FIREWALL_FILES: FirewallFiles = {
  script: SCRIPT,
  unit: UNIT,
  verifyUnit: VERIFY_UNIT,
  timer: TIMER,
};
