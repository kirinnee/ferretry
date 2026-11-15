import {
  LoginEnvironmentSection,
  type LoginEnvironmentSectionProps,
} from '../../../../app/features/login-environment.tsx';
import { useLoginChanges } from '../../../../app/lib/login-changes.ts';

type SectionProps = Omit<LoginEnvironmentSectionProps, 'changes' | 'machineName' | 'reload'> & {
  readonly reload?: () => Promise<void>;
};

/** The environment section with the change state the login page gives it, for a suite that has no page around it. */
export function EnvironmentSection({ reload = async () => undefined, ...props }: SectionProps) {
  const changes = useLoginChanges(props.client);
  return <LoginEnvironmentSection {...props} machineName="this machine" changes={changes} reload={reload} />;
}
