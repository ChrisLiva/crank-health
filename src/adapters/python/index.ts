import type { DetectContext, LanguageAdapter } from '../../core/types.ts'
import { complexipyRunner } from './complexipy.ts'
import { cosmicRayRunner } from './cosmic-ray.ts'
import { coverageRunner } from './coverage.ts'
import { mypyRunner } from './mypy.ts'
import { pyrightRunner } from './pyright.ts'
import { ruffFormatRunner, ruffLintRunner } from './ruff.ts'
import { tyRunner } from './ty.ts'
import { vultureRunner } from './vulture.ts'

/**
 * The Python language adapter. It answers one question — does this project
 * contain Python at all — and owns the runners that then get to look at it.
 * Discovery already classified every `.py`/`.pyi` file into its project, so
 * detection is a lookup.
 *
 * Runners are listed in category order (spec §10's remediation priority), and
 * within a category the defaults come before the ones that only run when the
 * repo owns them. All three type checkers are listed because which of them runs
 * depends on the repo: ty by default, pyright once there is a virtualenv,
 * whichever of them the repo owns, and mypy only where the repo asked for it
 * (see `ty.ts`, `pyright.ts` and `mypy.ts`).
 */
export const pythonAdapter: LanguageAdapter = {
  language: 'python',
  detect: (ctx: DetectContext) => Promise.resolve(ctx.project.files.byLanguage.python.length > 0),
  runners: [
    tyRunner,
    pyrightRunner,
    mypyRunner,
    vultureRunner,
    complexipyRunner,
    ruffLintRunner,
    ruffFormatRunner,
    cosmicRayRunner,
    coverageRunner,
  ],
}
