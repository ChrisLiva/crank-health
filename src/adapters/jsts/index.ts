import type { DetectContext, LanguageAdapter } from '../../core/types.ts'
import { biomeFormatRunner, biomeLintRunner } from './biome.ts'
import { eslintRunner } from './eslint.ts'
import { fallowDeadCodeRunner, fallowHealthRunner } from './fallow.ts'
import { ftaRunner } from './fta.ts'
import { knipRunner } from './knip.ts'
import { oxlintRunner } from './oxlint.ts'
import { prettierRunner } from './prettier.ts'
import { reactDoctorRunner } from './react-doctor.ts'
import { strykerRunner } from './stryker.ts'
import { tscRunner } from './tsc.ts'

/**
 * The JS/TS language adapter. It answers one question — does this project
 * contain JavaScript or TypeScript at all — and owns the list of runners that
 * then get to look at it. Discovery already classified every file into its
 * project, so detection is a lookup, not a search.
 *
 * Runners are listed in category order (spec §10's remediation priority), and
 * within a category the default tool comes before the ones that only run when
 * the repo owns them. Nothing depends on this order — the orchestrator sorts
 * findings and the renderers sort again — but it is how the file reads.
 */
export const jsTsAdapter: LanguageAdapter = {
  language: 'js-ts',
  detect: (ctx: DetectContext) => Promise.resolve(ctx.project.files.byLanguage['js-ts'].length > 0),
  runners: [
    tscRunner,
    fallowDeadCodeRunner,
    knipRunner,
    fallowHealthRunner,
    ftaRunner,
    oxlintRunner,
    eslintRunner,
    biomeLintRunner,
    reactDoctorRunner, // lint (default, complementary)
    prettierRunner,
    biomeFormatRunner,
    strykerRunner,
  ],
}
