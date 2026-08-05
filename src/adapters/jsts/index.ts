import type { LanguageAdapter, RepoContext } from '../../core/types.ts'
import { oxlintRunner } from './oxlint.ts'

/**
 * The JS/TS language adapter. It answers one question — does this repo contain
 * JavaScript or TypeScript at all — and owns the list of runners that then get
 * to look at it. Discovery already classified every file, so detection is a
 * lookup, not a search.
 */
export const jsTsAdapter: LanguageAdapter = {
  language: 'js-ts',
  detect: (repo: RepoContext) => Promise.resolve(repo.files.byLanguage['js-ts'].length > 0),
  runners: [oxlintRunner],
}
