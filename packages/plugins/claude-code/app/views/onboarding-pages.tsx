/** The Claude segment's first-run pages, as one view module the half loads on first use (like the other views). */
import '../features/onboarding/onboarding.css';
import '../features/onboarding/import/import.css';
export { ImportChoicePage } from '../features/onboarding/import-choice-page.tsx';
export { InstalledPage } from '../features/onboarding/installed-page.tsx';
export { PermissionPage } from '../features/onboarding/permission-page.tsx';
export { SignInPage } from '../features/onboarding/sign-in-page.tsx';
export { ConversationsPage } from '../features/onboarding/import/conversations-page.tsx';
export { ImportRunPage } from '../features/onboarding/import/import-run-page.tsx';
export {
  InstructionsPage,
  McpPage,
  ModelSetPage,
  SettingsPage,
  SkillsPage,
} from '../features/onboarding/import/kind-page.tsx';
