import type { DetectContext, LanguageAdapter } from '../../core/types.ts'
import {
  dotnetBuildComplexityRunner,
  dotnetBuildLintRunner,
  dotnetBuildTypesRunner,
} from './build.ts'
import { dotnetFormatRunner } from './dotnet-format.ts'
import { roslynatorRunner } from './roslynator.ts'

/**
 * The C# language adapter. It answers one question — does this project contain
 * C# at all — and owns the runners that then get to look at it. Discovery
 * already classified every `.cs` file into its project, so detection is a
 * lookup.
 *
 * Runners are listed in category order (spec §10's remediation priority), and
 * a later runner joins by its `CATEGORIES` index rather than by appending —
 * `common-invocation.test.ts` holds the standing order check.
 */
export const csharpAdapter: LanguageAdapter = {
  language: 'csharp',
  detect: (ctx: DetectContext) => Promise.resolve(ctx.project.files.byLanguage.csharp.length > 0),
  runners: [
    dotnetBuildTypesRunner,
    roslynatorRunner,
    dotnetBuildComplexityRunner,
    dotnetBuildLintRunner,
    dotnetFormatRunner,
  ],
}
