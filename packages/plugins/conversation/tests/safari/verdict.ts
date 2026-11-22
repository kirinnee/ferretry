/**
 * WHAT THE SAFARI PAGE MUST SHOW, as one pure function (r12 H8): the page's own report in, the lines that are wrong out; no
 * lines is a pass. Safari has no console or request endpoint, so the page reports itself (`collect.js`) and the driver only
 * reads that report and a few facts about the drawn message.
 */
export interface PageReport {
  /** `securitypolicyviolation` events, including Trusted Types where Safari has it. */
  readonly csp: readonly string[];
  /** Uncaught errors, unhandled rejections and failed resource loads (an image, a script, a stylesheet). */
  readonly errors: readonly string[];
  /** Every `console.error` and `console.warn` call the page made. */
  readonly console: readonly string[];
  /** How many `.dh-doc` roots the page drew. */
  readonly docs: number;
  /** How many times each of {@link REQUIRED_PARTS} was drawn inside the message. */
  readonly parts: Readonly<Record<string, number>>;
}

/** The parts the page's message holds (a terminal, a file tree, tabs, a tier list, an accordion), by what Durian draws for each. */
export const REQUIRED_PARTS = ['.term', '.fx', '[role="tablist"]', '.tl', '.accordion details'] as const;

export const verdict = (report: PageReport): string[] => [
  ...(report.docs === 1 ? [] : [`expected one .dh-doc, found ${report.docs}`]),
  ...REQUIRED_PARTS.filter(selector => (report.parts[selector] ?? 0) < 1).map(selector => `no ${selector} was drawn`),
  ...report.csp.map(entry => `policy violation: ${entry}`),
  ...report.errors.map(entry => `page error: ${entry}`),
  ...report.console.map(entry => `console: ${entry}`),
];
