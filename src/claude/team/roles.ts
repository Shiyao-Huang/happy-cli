/**
 * @module roles
 * @description Barrel re-export for backwards compatibility.
 * Real implementations live in roleConstants, rolePredicates, and promptBuilder.
 *
 * ```mermaid
 * graph TD
 *   A[roles barrel] --> B[roleConstants]
 *   A --> C[rolePredicates]
 *   A --> D[promptBuilder]
 * ```
 */
export * from './roleConstants';
export * from './rolePredicates';
export * from './promptBuilder';
