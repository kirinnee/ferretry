/**
 * Onboarding's one door to Runtimes' scan (`@ferretry/plugin-runtimes/import-kit`): the flow starts and forgets the machine's
 * read ahead, the AI picker only looks at it, and the tests that drive them (they may not import another plugin's half, as the
 * app half may) start the same read and stand in for another reader of the scan, as the Settings import is.
 */
export { forgetSetupScanAhead, readSetupScanAhead, useScan, useScanAhead } from '@ferretry/plugin-runtimes/import-kit';
