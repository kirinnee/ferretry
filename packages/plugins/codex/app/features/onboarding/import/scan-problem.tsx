/**
 * What an import page says when the scan could not be shown: the machine wants the person's own press (it may raise the
 * passkey), or it failed and a retry is offered. The same words and buttons as Claude Code's pages. Nothing here holds a value.
 */
import { Button } from '@ferretry/app';
import { type ScanRead, StepActions, StepLine } from '@ferretry/plugin-runtimes/import-kit';

export function ScanProblem({ read, look }: { readonly read: ScanRead; readonly look: () => Promise<void> }) {
  if (read.kind === 'confirm')
    return (
      <StepActions>
        <StepLine>Ferretry needs your OK before it reads what Codex keeps on this computer.</StepLine>
        <Button variant="primary" data-import-look="" onClick={() => void look()}>
          Show what is there
        </Button>
      </StepActions>
    );
  if (read.kind === 'failed')
    return (
      <StepActions>
        <StepLine role="alert" data-import-failed="">
          {read.sentence}
        </StepLine>
        <Button data-import-look="" onClick={() => void look()}>
          Try again
        </Button>
      </StepActions>
    );
  return null;
}
