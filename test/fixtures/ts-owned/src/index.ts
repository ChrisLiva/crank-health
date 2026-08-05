import { classify } from './complex'
import { total } from './types'
import { shout } from './unformatted'
import { slugify } from './util'

export function summarize(names: string[], values: number[]): string {
  return `${slugify(names.join(' '))}:${total(values)}:${classify(1, 2, 3, 4)}:${shout('x')}`
}
