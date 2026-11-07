/**
 * A {@link ConfigText} for tests, built from the kernel's own YAML tools so comments and key order behave as they do
 * on a machine. Judging what a written file would loosen is the owner of each file's rule; here it is a small stand-in
 * that knows the three things the settings tests rely on (a spending layer switched on, a raised cap, a faster sweep).
 */
import { config } from '@ferretry/kernel/host';
import type { ConfigText, SettingsFile } from '../../../../daemon/lib/ports.ts';

/** The warden settings in effect when nobody wrote a file (the fields the tests judge). */
export const DEFAULT_WARDEN_CONFIG = {
  enabled: true,
  layers: { jev: false, llm: false },
  caps: { jevUsdPerDay: 0.5, investigationUsdPerDay: 2, maxInvestigationsPerHour: 6 },
  intervalMinutes: 2,
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const LAYER_WORDS: Readonly<Record<string, string>> = {
  jev: 'Jev may now spend',
  llm: 'the LLM investigation may now spend',
};
const CAP_WORDS: Readonly<Record<string, string>> = {
  jevUsdPerDay: 'the daily Jev cap in dollars',
  investigationUsdPerDay: 'the daily investigation cap in dollars',
  maxInvestigationsPerHour: 'the investigations allowed per hour',
};

function wardenLoosening(effective: typeof DEFAULT_WARDEN_CONFIG, written: Record<string, unknown>): readonly string[] {
  const sentences: string[] = [];
  const layers = record(written.layers);
  for (const [layer, words] of Object.entries(LAYER_WORDS)) {
    const was = effective.layers[layer as 'jev' | 'llm'];
    if (layers[layer] === true && was !== true) sentences.push(words);
  }
  const caps = record(written.caps);
  for (const [cap, words] of Object.entries(CAP_WORDS)) {
    const was = effective.caps[cap as keyof typeof effective.caps];
    const now = caps[cap];
    if (typeof now === 'number' && now > was) sentences.push(`${words} goes up from ${String(was)} to ${String(now)}`);
  }
  const interval = written.intervalMinutes;
  if (typeof interval === 'number' && interval < effective.intervalMinutes) {
    sentences.push(
      'the minutes between Warden sweeps goes down from ' +
        String(effective.intervalMinutes) +
        ' to ' +
        String(interval),
    );
  }
  return sentences;
}

export const configText: ConfigText = {
  read: text => config.readConfigText(text),
  edit: (existing, target, current, modeline) => config.editConfigText(existing, target, current, modeline),
  hasRawSecret: document => config.findRawSecrets(document).length > 0,
  loosening: (path: SettingsFile, effective, text) => {
    const read = config.readConfigText(text);
    if (!read.ok) return undefined;
    if (path !== 'warden.yaml') return [];
    return wardenLoosening(effective as typeof DEFAULT_WARDEN_CONFIG, record(read.read.value));
  },
  modeline: path => `# yaml-language-server: $schema=../schema/${path.replace(/\.yaml$/u, '')}.json`,
};
