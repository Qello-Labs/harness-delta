export { Store } from './store.js';
export { ReadingSchema, EventSchema, ComparisonModeSchema, MonetaryAmountSchema, SharedTaskSchema, SharedOutcomeSchema, addTokens } from './contracts.js';
export type { Reading, Event } from './contracts.js';

export { VariantSchema, ProtocolDraftSchema, ProtocolSchema, AssignmentInputSchema, ConfirmationInputSchema } from './comparison-contracts.js';
export { registerVariant, registerProtocol, freezeProtocol, showVariant } from './comparison.js';
export { showProtocol } from './readiness-store.js';
export { assignTask } from './comparison/allocation.js';
export type { AllocationDependencies, AssignmentReceipt } from './comparison/allocation.js';
export { configurationHistory, bindConfigurationToSession } from './core/configuration-evidence.js';
export { confirmConfiguration } from './comparison/config-confirmation-write.js';
export type { SelectedArtifact, ConfigurationRecord } from './core/configuration-evidence.js';

export * from './flexible-contracts.js';
export { recordRuntimeEvidence, readRuntimeHistory, putUsageWithEvidence, recordObservationGap } from './runtime-history.js';
export { registerPriceTable, readPriceTable, priceUsage, costFormulaVersion } from './pricing.js';
export { evaluateCostCoverage } from './cost-coverage.js';
export { aggregateTaskCost } from './metrics.js';
export { projectFlexibleComparison, aggregateFlexibleTaskReport } from './comparison/reports/flexible-comparison.js';
export { evaluateReadiness } from './readiness.js';
export { comparisonReadiness } from './readiness-store.js';

export { SourceCompatibilitySchema } from './contracts.js';
export type { SourceCompatibility } from './contracts.js';
export { resolveSourceCompatibility, sourceCompatibilityWindows, sessionCompatibility, invalidateCompatibility } from './source-compatibility.js';
