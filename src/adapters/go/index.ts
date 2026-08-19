import type { DetectContext, LanguageAdapter } from '../../core/types.ts'
import { gocognitRunner } from './gocognit.ts'
import { gofmtRunner } from './gofmt.ts'
import { golangciLintRunner } from './golangci-lint.ts'
import { goVetRunner } from './go-vet.ts'
import {
  staticcheckDeadCodeRunner,
  staticcheckLintRunner,
  staticcheckTypesRunner,
} from './staticcheck.ts'

/**
 * The Go language adapter. It answers one question — does this project contain
 * Go at all — and owns the runners that then get to look at it. Discovery
 * already classified every `.go` file into its project (and kept the vendored
 * ones out entirely), so detection is a lookup.
 *
 * Runners are listed in category order (spec §10's remediation priority), and a
 * later runner joins by its `CATEGORIES` index rather than by appending.
 *
 * Every runner here is declared `run: withGoGate(runX)` and none spells the
 * toolchain gate itself: the contract is that a machine without a usable Go
 * degrades every Go tool with the same sentence, and that is true by
 * construction only while the gate has one home (`go-toolchain.ts`).
 */
export const goAdapter: LanguageAdapter = {
  language: 'go',
  detect: (ctx: DetectContext) => Promise.resolve(ctx.project.files.byLanguage.go.length > 0),
  runners: [
    staticcheckTypesRunner,
    staticcheckDeadCodeRunner,
    gocognitRunner,
    staticcheckLintRunner,
    goVetRunner,
    golangciLintRunner,
    gofmtRunner,
  ],
}
