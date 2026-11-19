/**
 * CREATE A PROJECT: Folder → Name → GitHub accounts → Push and signing → Done, as a real stepper (`StepPageFrame`, one
 * page per step) in a sheet on a desktop and a full page on a phone.
 *
 * The folder is registered when the name step is confirmed; everything after that links accounts and sets up keys on a
 * project that already exists, so leaving at any step leaves a real, usable project and never half of one. Accounts and
 * keys are both skippable, and there is no Back past the registration.
 *
 * The registration itself is the page's (`onRegister`, with its status): the page fences a write to the daemon it was
 * issued against, and this flow does not reimplement that. The flow advances when the page reports the project registered.
 */
import { useEffect, useState } from 'react';
import type { ProjectInfo, ProjectsConnectAccount, RegisterProjectRequest } from '../../../contract/index.ts';
import type { ProjectsClient } from '../../lib/client.ts';
import type { ProjectRegistrationStatus } from '../../lib/registration-model.ts';
import { AccountsStep } from './accounts-step.tsx';
import { CreateSheet } from './create-sheet.tsx';
import {
  CREATE_STEPS,
  type CreateDraft,
  type CreateStep,
  createProgress,
  createVerdict,
  emptyCreateDraft,
} from './create-project-model.ts';
import { DoneStep } from './done-step.tsx';
import { FolderStep } from './folder-step.tsx';
import { KeysStep } from './keys-step.tsx';
import { NameStep } from './name-step.tsx';
import { useGitAccounts } from './use-git-accounts.ts';

export interface CreateProjectFlowProps {
  readonly client: ProjectsClient;
  /** Git accounts' connect card, when this machine has it (the page reads the hook). */
  readonly connectAccount?: ProjectsConnectAccount;
  readonly status: ProjectRegistrationStatus | null;
  /** Sends the registration; `false` is a refusal (the status says why). */
  readonly onRegister: (request: RegisterProjectRequest) => Promise<boolean>;
  readonly onClose: () => void;
  readonly projectHref?: (projectId: string) => string;
  readonly onNavigate?: (to: string) => void;
  /** Which way the first page starts: an existing folder, or a repository to clone. */
  readonly initialSource?: CreateDraft['source'];
}

export function CreateProjectFlow({
  client,
  connectAccount,
  status,
  onRegister,
  onClose,
  projectHref,
  onNavigate,
  initialSource = 'folder',
}: CreateProjectFlowProps) {
  const [step, setStep] = useState<CreateStep>('folder');
  const [draft, setDraft] = useState<CreateDraft>({ ...emptyCreateDraft, source: initialSource });
  const [registering, setRegistering] = useState<RegisterProjectRequest | null>(null);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [linked, setLinked] = useState<readonly string[]>([]);
  const accounts = useGitAccounts(client);
  const progress = createProgress(step, CREATE_STEPS);

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

  return (
    <CreateSheet onClose={onClose}>
      <div data-create-project={step} className="flex min-h-0 flex-1 flex-col [&>.fy-spf]:flex-1">
        {step === 'folder' && (
          <FolderStep
            client={client}
            draft={draft}
            progress={progress}
            onDraftChange={setDraft}
            onNext={() => setStep('name')}
          />
        )}
        {step === 'name' && (
          <NameStep
            draft={draft}
            progress={progress}
            onDraftChange={setDraft}
            status={status}
            onBack={() => setStep('folder')}
            onCreate={create}
          />
        )}
        {step === 'accounts' && project !== null && (
          <AccountsStep
            client={client}
            connectAccount={connectAccount}
            projectId={project.id}
            progress={progress}
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
        {step === 'keys' && (
          <KeysStep
            client={client}
            progress={progress}
            accounts={accounts}
            linked={linked}
            onNext={() => setStep('done')}
          />
        )}
        {step === 'done' && project !== null && (
          <DoneStep
            project={{ ...project, accounts: linked.length > 0 ? [...linked] : project.accounts }}
            progress={progress}
            accounts={accounts}
            {...(projectHref === undefined ? {} : { projectHref })}
            {...(onNavigate === undefined ? {} : { onNavigate })}
            onClose={onClose}
          />
        )}
      </div>
    </CreateSheet>
  );
}
