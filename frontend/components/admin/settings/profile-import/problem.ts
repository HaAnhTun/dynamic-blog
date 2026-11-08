import type { ImportProblem } from '@/lib/admin-site-import'
import type { Translator } from '@/i18n/translator'

/**
 * `Heading, line N, field: message`. Any part the backend did not give is left out; `t` is the `…profileImport.preview`
 * translator. The message never echoes a value of the file.
 */
export function problemText(problem: ImportProblem, heading: string | null, t: Translator): string {
  const where = [
    heading,
    problem.line === null ? null : t('lineNumber', { line: problem.line }),
    problem.field === null || problem.field === '' ? null : problem.field,
  ].filter((part): part is string => part !== null && part !== '')
  return where.length === 0 ? problem.message : t('problem', { where: where.join(', '), message: problem.message })
}
