import {
  type Reading,
  scoreCreepJs,
  scoreIncolumitas,
  scoreNavia,
  scoreRebrowser,
  scoreRecaptchaV3,
  scoreSannysoft,
  scoreTurnstile,
} from './scorers.ts';

export interface Check {
  readonly id: string;
  readonly url: string;
  readonly score: (html: string) => Reading;
  /** How long to keep re-reading a page whose score is not on screen yet, in ms. */
  readonly settleMs: number;
  /**
   * When reading stops. `scored`: at the first readable score (a page whose tests are static once printed).
   * `pass`: only at a pass, or when the settle time is spent — a token or a challenge that clears by itself is
   * not a fail until it has had its time.
   */
  readonly until: 'scored' | 'pass';
}

export const CHECKS: readonly Check[] = [
  { id: 'sannysoft', url: 'https://bot.sannysoft.com/', score: scoreSannysoft, settleMs: 20_000, until: 'scored' },
  {
    id: 'creepjs',
    url: 'https://abrahamjuliot.github.io/creepjs/',
    score: scoreCreepJs,
    settleMs: 45_000,
    until: 'scored',
  },
  {
    id: 'incolumitas',
    url: 'https://bot.incolumitas.com/',
    score: scoreIncolumitas,
    settleMs: 30_000,
    until: 'scored',
  },
  {
    id: 'rebrowser',
    url: 'https://bot-detector.rebrowser.net/',
    score: scoreRebrowser,
    settleMs: 30_000,
    until: 'scored',
  },
  {
    id: 'turnstile',
    url: 'https://nopecha.com/demo/turnstile',
    score: scoreTurnstile,
    settleMs: 40_000,
    until: 'pass',
  },
  {
    id: 'recaptcha-v3',
    url: 'https://recaptcha-demo.appspot.com/recaptcha-v3-request-scores.php',
    score: scoreRecaptchaV3,
    settleMs: 30_000,
    until: 'scored',
  },
  { id: 'navia', url: 'https://app.naviabenefits.com/#/login', score: scoreNavia, settleMs: 40_000, until: 'pass' },
];

/** The hosts the suite may load: exactly the hosts of its own checks, and nothing a redirect or a typo adds. */
const HOSTS = new Set(CHECKS.map(check => new URL(check.url).host));
export const allowedHost = (url: string): boolean => HOSTS.has(new URL(url).host);
