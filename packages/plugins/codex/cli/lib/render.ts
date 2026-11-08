import type { HarnessCliView } from '../../contract/index.ts';

const LABEL = 'Codex';

/** Where a version stands against the one Ferretry verified, in words. */
function verificationWords(view: HarnessCliView): string {
  switch (view.verification) {
    case 'verified':
      return `${view.installed?.state === 'ok' ? view.installed.version : ''} is the version Ferretry verified`.trim();
    case 'older':
      return `older than ${view.verified.version}, the version Ferretry verified`;
    case 'unverified':
      return `not yet verified by Ferretry (verified: ${view.verified.version}) - ${view.verified.url}`;
    case 'unknown':
      return `Ferretry verified ${view.verified.version}`;
  }
}

const installedText = (view: HarnessCliView): string | undefined =>
  view.installed?.state === 'ok' ? view.installed.version : undefined;

const latestRelease = (view: HarnessCliView): string | undefined => {
  const check = view.check;
  if (check.state === 'ok') return check.latest.version;
  if (check.state === 'failed') return check.lastKnown?.latest.version;
  return undefined;
};

/** `fy harness codex status`: where codex is, what it runs, and what updating takes. */
export function renderStatus(view: HarnessCliView, binaryName: string): string {
  const location = view.location;
  if (location.state === 'absent')
    return [
      `${LABEL}: not found on this machine`,
      `  Searched PATH${location.searched.length === 0 ? '' : ` and ${location.searched.join(', ')}`}.`,
    ].join('\n');
  if (location.state === 'override-absent') return `${LABEL}: not usable - ${location.reason}`;
  const installed = installedText(view);
  const latest = latestRelease(view);
  const lines = [
    view.available && latest !== undefined
      ? `${LABEL} ${installed ?? '(version unreadable)'} - update available: ${latest}${view.verification === 'unverified' ? ' (not yet verified by Ferretry)' : ''}`
      : `${LABEL} ${installed ?? '(version unreadable)'}${latest === undefined ? '' : ' - up to date'}`,
    `  Runs:       ${location.path}  (${location.rule} - ${location.declaredBy})`,
    ...(view.method === null ? [] : [`  Installed:  ${view.method.kind}`]),
    ...(view.installed?.state === 'unreadable' ? [`  Version:    unreadable - ${view.installed.reason}`] : []),
    `  Verified:   ${verificationWords(view)}`,
    view.check.state === 'never'
      ? '  Latest:     not checked'
      : view.check.state === 'ok'
        ? `  Latest:     ${view.check.latest.version} on npm, checked ${view.check.checkedAt}`
        : `  Latest:     the check at ${view.check.checkedAt} failed: ${view.check.reason}${view.check.lastKnown === undefined ? '' : ` (last known ${view.check.lastKnown.latest.version})`}`,
  ];
  const plan = view.plan;
  if (plan?.kind === 'self')
    lines.push(
      `  Update:     ${binaryName} harness codex update - runs ${plan.steps.map(step => step.command).join(', then ')}`,
    );
  else if (plan?.kind === 'manual')
    lines.push(
      `  Update:     ${plan.explanation}`,
      ...plan.steps.map(step => `    ${step.command}${step.note === undefined ? '' : `   # ${step.note}`}`),
    );
  if (view.job?.state === 'running') lines.push(`  Updating:   running ${view.job.command}`);
  if (view.job?.state === 'finished') lines.push(`  Last update: ${view.job.report.message}`);
  lines.push('', 'Running ferrets keep the version they started with until they are restarted.');
  return lines.join('\n');
}
