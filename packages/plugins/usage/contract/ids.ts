/**
 * The ids and shapes Usage shares with another plugin: a login's (§2.4: Usage -> Logins is the only plugin contract
 * edge it has). Re-exported here so Usage's own files name them from one place.
 */
export {
  type LoginBudget,
  type LoginBudgetLevel,
  type LoginBudgetPeriodView,
  type LoginId,
  LoginIdSchema,
  type LoginList,
  type LoginUsage,
  type LoginUsageWindow,
  type LoginView,
  type ProviderPresetCatalog,
  type ProviderQuotaBalance,
  type ProviderQuotaReading,
  type ProviderQuotaSource,
  type ProviderQuotaSpend,
  type ProviderQuotaWindow,
  ProviderQuotaWindowSchema,
  ProviderQuotaReadingSchema,
} from '@ferretry/plugin-logins/contract';
