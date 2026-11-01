/**
 * What the inventory knows about one MCP server, as plain lines: where it is declared, what it points at,
 * and which runtimes see it. The address has no query and the program no arguments by construction, so
 * this never shows a credential; hidden and format characters are marked.
 */

import { type McpInventoryServer, revealHidden } from '@ferretry/protocol';

const HARNESS_LABEL: Readonly<Record<McpInventoryServer['harness'], string>> = {
  claude: 'Claude',
  codex: 'Codex',
};

const APPROVAL_LABEL = {
  approved: 'approved',
  pending: 'waiting for approval',
  disabled: 'turned off',
} as const;

function Line({
  label,
  value,
  mono = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 gap-xs">
      <dt className="shrink-0 text-faint">{label}</dt>
      <dd className={`m-0 min-w-0 break-all text-muted ${mono ? 'font-mono text-2xs' : ''}`}>{value}</dd>
    </div>
  );
}

export function McpServerDetails({ server }: { readonly server: McpInventoryServer }) {
  const runtimes = server.runtimes.map(use =>
    use.approval === undefined ? use.runtime : `${use.runtime} (${APPROVAL_LABEL[use.approval]})`,
  );
  return (
    <dl className="m-0 flex min-w-0 flex-col gap-0.5 px-xs pb-xs text-meta" data-mcp-details={server.name}>
      <Line label={server.transport === 'stdio' ? 'Runs' : 'Address'} value={revealHidden(server.target)} mono />
      {server.source === undefined ? null : <Line label="Declared in" value={revealHidden(server.source)} mono />}
      {server.project === undefined ? null : (
        <Line label="Project" value={revealHidden(server.project.name ?? server.project.root)} />
      )}
      <Line label="Harness" value={HARNESS_LABEL[server.harness]} />
      {runtimes.length === 0 ? null : <Line label="Seen by" value={runtimes.join(', ')} />}
    </dl>
  );
}
