import {
  describeHarnessInstall,
  HARNESS_CLI_LABELS,
  type HarnessCliView,
  type HarnessUpdateView,
  harnessInstallLabel,
  harnessVerification,
  installedHarnessVersion,
  knownLatestRelease,
} from '@ferretry/protocol';

/** Where a version stands against the one Ferretry verified, in words. */
export function verificationWords(view: HarnessCliView, version: string | undefined): string {
  switch (harnessVerification(view.harness, version)) {
    case 'verified':
      return `${version ?? ''} is the version Ferretry verified`;
    case 'older':
      return `older than ${view.verified.version}, the version Ferretry verified`;
    case 'unverified':
      return `not yet verified by Ferretry (verified: ${view.verified.version}) — ${view.verified.url}`;
    case 'unknown':
      return `Ferretry verified ${view.verified.version}`;
  }
}

function oneHarness(view: HarnessCliView, binaryName: string): readonly string[] {
  const label = HARNESS_CLI_LABELS[view.harness];
  const location = view.location;
  if (location.state === 'absent')
    return [
      `${label}: not found on this machine`,
      `  Searched PATH${location.searched.length === 0 ? '' : ` and ${location.searched.join(', ')}`}.`,
    ];
  if (location.state === 'override-absent') return [`${label}: not usable — ${location.reason}`];
  const installed = installedHarnessVersion(view);
  const latest = knownLatestRelease(view.check);
  const headline =
    view.available && latest !== undefined
      ? `${label} ${installed ?? '(version unreadable)'} — update available: ${latest.version}${harnessVerification(view.harness, latest.version) === 'unverified' ? ' (not yet verified by Ferretry)' : ''}`
      : `${label} ${installed ?? '(version unreadable)'}${latest === undefined ? '' : ' — up to date'}`;
  const lines = [
    headline,
    `  Runs:       ${location.path}  (${location.rule} — ${location.declaredBy})`,
    ...(view.method === null
      ? []
      : [`  Installed:  ${harnessInstallLabel(view.method)} — ${describeHarnessInstall(view.method)}`]),
    ...(view.installed?.state === 'unreadable' ? [`  Version:    unreadable — ${view.installed.reason}`] : []),
    `  Verified:   ${verificationWords(view, installed)}`,
    view.check.state === 'never'
      ? '  Latest:     not checked'
      : view.check.state === 'ok'
        ? `  Latest:     ${view.check.latest.version} on npm, checked ${view.check.checkedAt}`
        : `  Latest:     the check at ${view.check.checkedAt} failed: ${view.check.reason}${view.check.lastKnown === undefined ? '' : ` (last known ${view.check.lastKnown.latest.version})`}`,
  ];
  const plan = view.plan;
  if (plan?.kind === 'self')
    lines.push(
      `  Update:     ${binaryName} harness update ${view.harness} — runs ${plan.steps.map(step => step.command).join(', then ')}`,
    );
  else if (plan?.kind === 'manual')
    lines.push(
      `  Update:     ${plan.explanation}`,
      ...plan.steps.map(step => `    ${step.command}${step.note === undefined ? '' : `   # ${step.note}`}`),
    );
  if (view.job?.state === 'running') lines.push(`  Updating:   running ${view.job.command}`);
  if (view.job?.state === 'finished') lines.push(`  Last update: ${view.job.report.message}`);
  return lines;
}

/** `fy harness status`: each harness, where it is, what it runs, and what updating takes. */
export function renderHarnessStatus(view: HarnessUpdateView, binaryName: string): string {
  return [
    ...view.harnesses.flatMap((harness, index) => [...(index === 0 ? [] : ['']), ...oneHarness(harness, binaryName)]),
    '',
    'Running ferrets keep the version they started with until they are restarted.',
  ].join('\n');
}
