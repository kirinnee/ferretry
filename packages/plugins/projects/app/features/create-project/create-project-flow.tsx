/**
 * CREATE A PROJECT: Folder → Name → GitHub accounts → Push and signing → Done.
 *
 * The folder is registered when the name step is confirmed; everything after that links accounts and sets up keys on a
 * project that already exists, so leaving at any step leaves a real, usable project and never half of one. Accounts and
 * keys are both skippable.
 *
 * The registration itself is the page's (`onRegister`, with its status): the page fences a write to the daemon it was
 * issued against, and this flow does not reimplement that. The flow advances when the page reports the project registered.
 */
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ProjectInfo, RegisterProjectRequest } from '../../../contract/index.ts';
import type { ProjectsClient } from '../../lib/client.ts';
import type { ProjectRegistrationStatus } from '../../lib/registration-model.ts';
import { AccountsStep } from './accounts-step.tsx';
import {
  CREATE_STEPS,
  type CreateDraft,
  type CreateStep,
  createVerdict,
  emptyCreateDraft,
  STEP_LABELS,
} from './create-project-model.ts';
import { DoneStep } from './done-step.tsx';
import { FolderStep } from './folder-step.tsx';
import { KeysStep } from './keys-step.tsx';
import { NameStep } from './name-step.tsx';
import { useGitAccounts } from './use-git-accounts.ts';

export interface CreateProjectFlowProps {
  readonly client: ProjectsClient;
  readonly status: ProjectRegistrationStatus | null;
  /** Sends the registration; `false` is a refusal (the status says why). */
  readonly onRegister: (request: RegisterProjectRequest) => Promise<boolean>;
  readonly onClose: () => void;
  readonly projectHref?: (projectId: string) => string;
  readonly onNavigate?: (to: string) => void;
}

function StepList({ step }: { readonly step: CreateStep }) {
  const at = CREATE_STEPS.indexOf(step);
  return (
    <ol className="m-0 flex list-none flex-wrap gap-xs p-0 text-meta" aria-label="Steps">
      {CREATE_STEPS.map((each, index) => (
        <li
          key={each}
          aria-current={each === step ? 'step' : undefined}
          data-create-step-marker={each}
          className={`flex items-center gap-1 rounded-control px-2 py-1 ${
            each === step ? 'bg-accent-soft font-semibold text-accent' : index < at ? 'text-muted' : 'text-faint'
          }`}
        >
          {index < at ? <Check size={12} aria-hidden="true" /> : <span>{index + 1}</span>}
          {STEP_LABELS[each]}
        </li>
      ))}
    </ol>
  );
}

export function CreateProjectFlow({
  client,
  status,
  onRegister,
  onClose,
  projectHref,
  onNavigate,
}: CreateProjectFlowProps) {
  const [step, setStep] = useState<CreateStep>('folder');
  const [draft, setDraft] = useState<CreateDraft>(emptyCreateDraft);
  const [registering, setRegistering] = useState<RegisterProjectRequest | null>(null);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [linked, setLinked] = useState<readonly string[]>([]);
  const accounts = useGitAccounts(client);

  // The page reports the registration; this flow moves on only for the request it sent.
  useEffect(() => {
    if (registering === null || status?.phase !== 'registered' || status.request !== registering) return;
    setProject(status.project);
    setRegistering(null);
    setStep('accounts');
  }, [registering, status]);

  const create = (): void => {
    const { request } = createVerdict(draft);
    if (request === null) return;
    setRegistering(request);
    void onRegister(request).then(accepted => {
      if (!accepted) setRegistering(null);
    });
  };

  const linkedRows = (accounts.accounts ?? []).filter(account => linked.includes(account.id));

  return (
    <section
      className="grid min-w-0 gap-md border-t border-border-soft pt-panel"
      data-create-project={step}
      aria-label="Create a project"
    >
      <StepList step={step} />
      {step === 'folder' && (
        <FolderStep client={client} draft={draft} onDraftChange={setDraft} onNext={() => setStep('name')} />
      )}
      {step === 'name' && (
        <NameStep
          draft={draft}
          onDraftChange={setDraft}
          status={status}
          onBack={() => setStep('folder')}
          onCreate={create}
        />
      )}
      {step === 'accounts' && project !== null && (
        <AccountsStep
          client={client}
          projectId={project.id}
          accounts={accounts}
          selected={selected}
          onSelectedChange={setSelected}
          onLinked={ids => {
            setLinked(ids);
            accounts.reload();
            setStep('keys');
          }}
          onSkip={() => setStep('done')}
        />
      )}
      {step === 'keys' && <KeysStep client={client} accounts={linkedRows} onNext={() => setStep('done')} />}
      {step === 'done' && project !== null && (
        <DoneStep
          project={{ ...project, accounts: linked.length > 0 ? [...linked] : project.accounts }}
          accounts={accounts}
          {...(projectHref === undefined ? {} : { projectHref })}
          {...(onNavigate === undefined ? {} : { onNavigate })}
          onClose={onClose}
        />
      )}
    </section>
  );
}
