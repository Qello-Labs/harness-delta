export { Store } from './store.js';
export { ReadingSchema, EventSchema, ComparisonModeSchema, MonetaryAmountSchema, SharedTaskSchema, SharedOutcomeSchema, addTokens } from './contracts.js';
export type { Reading, Event } from './contracts.js';

export { VariantSchema, ProtocolDraftSchema, ProtocolSchema, AssignmentInputSchema, ConfirmationInputSchema } from './comparison-contracts.js';
export { registerVariant, registerProtocol, freezeProtocol, showVariant, showProtocol } from './comparison.js';
export { assignTask } from './allocation.js';
export type { AllocationDependencies, AssignmentReceipt } from './allocation.js';
export { confirmConfiguration, configurationHistory, bindConfigurationToSession } from './config-confirmation.js';
export type { SelectedArtifact, ConfigurationRecord } from './config-confirmation.js';

export * from './flexible-contracts.js';
export { recordRuntimeEvidence, readRuntimeHistory, putUsageWithEvidence, recordObservationGap } from './runtime-history.js';
export { registerPriceTable, readPriceTable, priceUsage, costFormulaVersion } from './pricing.js';
export { evaluateCostCoverage } from './cost-coverage.js';
export { aggregateTaskCost } from './metrics.js';
export { projectFlexibleComparison, aggregateFlexibleTaskReport } from './reports/flexible-comparison.js';
export { evaluateReadiness } from './readiness.js';
export { comparisonReadiness } from './readiness-store.js';

export { SourceCompatibilitySchema } from './contracts.js';
export type { SourceCompatibility } from './contracts.js';
export { resolveSourceCompatibility, sourceCompatibilityWindows, sessionCompatibility, invalidateCompatibility } from './source-compatibility.js';
