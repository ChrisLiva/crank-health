import type { LanguageAdapter } from '../core/types.ts'
import { jsTsAdapter } from './jsts/index.ts'

/**
 * Every adapter the orchestrator is offered, in a fixed order so that runs,
 * warnings and raw file names are deterministic. Adapters whose language is not
 * present in the target simply detect `false` and cost nothing.
 */
export const ADAPTERS: readonly LanguageAdapter[] = [jsTsAdapter]
