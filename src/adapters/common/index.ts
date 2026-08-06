import type { DetectContext, LanguageAdapter } from '../../core/types.ts'
import { banditRunner } from './bandit.ts'
import { gitleaksRunner } from './gitleaks.ts'
import { jscpdRunner } from './jscpd.ts'
import { opengrepRunner } from './opengrep.ts'
import { osvScannerRunner } from './osv-scanner.ts'
import { zizmorRunner } from './zizmor.ts'

/**
 * The cross-language adapter: tools that do not belong to one language's
 * toolchain (plan: "Cross-language tools live in a `common` pseudo-adapter with
 * the same `ToolRunner` shape").
 *
 * It detects `true` for any repo with a file in it, because that is what its
 * runners are about — a secret, a vulnerable dependency or a badly written
 * workflow is not a property of the language it sits next to. The runners
 * themselves decide whether they have anything to look at, and say so.
 *
 * Every security runner here is `complementary`: they are a union, not a menu
 * (spec "Categories and tools" lists security as opengrep + gitleaks + zizmor +
 * bandit, and a repo owning one of them must not stand the rest down).
 */
export const commonAdapter: LanguageAdapter = {
  language: 'common',
  detect: (ctx: DetectContext) => Promise.resolve(ctx.files.all.length > 0),
  runners: [
    gitleaksRunner,
    opengrepRunner,
    zizmorRunner,
    banditRunner,
    osvScannerRunner,
    jscpdRunner,
  ],
}
