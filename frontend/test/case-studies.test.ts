import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultSiteContent } from '@/content/defaults'
import { routing } from '@/i18n/routing'

/**
 * The packaged default case studies (`content/defaults/<locale>/case_studies.json`), checked for exactly what makes a case
 * study useless: not for length, tone or count. The owner's own case studies live in the database and are validated by the
 * backend on save (`com.blog.sitecontent`); this test keeps the packaged example honest, because it is what a fresh install
 * shows and what the build falls back to.
 *
 * What it cannot judge: whether a cited post really talks about the case study. The old "every cited post exists in
 * seed/articles" check applied only to the owner's data and is gone with it; the packaged examples cite no post.
 */

describe.each(routing.locales)('packaged case studies (%s)', (locale) => {
  const { caseStudies } = defaultSiteContent(locale)

  it('has data to check', () => {
    // The gate that makes every assertion below meaningful: iterating over an empty array makes every test
    // green while checking nothing.
    expect(caseStudies.length).toBeGreaterThan(0)
  })

  it('every measurement has a reproducible source', () => {
    // `source` is what separates a measurement from a boast. The type forces the field to exist; it cannot catch an empty
    // string or a single space, so the test does.
    for (const study of caseStudies) {
      expect(study.results.length, `${study.slug}: no measurements`).toBeGreaterThan(0)
      for (const row of study.results) {
        expect(row.source.trim().length, `${study.slug} / ${row.label}: source is empty`).toBeGreaterThan(5)
        expect(row.value.trim().length, `${study.slug} / ${row.label}: value is empty`).toBeGreaterThan(0)
      }
    }
  })

  it('none of the sections is left empty, including the hardest one', () => {
    // "If redone" is the only part that cannot be taken from the changelog, and also the part most easily
    // dropped when writing in a hurry. A case study missing it turns back into a feature description.
    for (const study of caseStudies) {
      for (const [name, body] of [
        ['problem', study.problem],
        ['constraints', study.constraints],
        ['solution', study.solution],
        ['ifRedone', study.ifRedone],
      ] as const) {
        expect(body.length, `${study.slug}: ${name} is empty`).toBeGreaterThan(0)
        for (const paragraph of body) {
          expect(paragraph.trim().length, `${study.slug}: ${name} has an empty paragraph`).toBeGreaterThan(20)
        }
      }
    }
  })

  it('does not cite the same post twice in one case study, and cites only well-formed slugs', () => {
    for (const study of caseStudies) {
      const slugs = study.readMore.map((item) => item.slug)
      expect(new Set(slugs).size, `${study.slug}: a post is cited twice`).toBe(slugs.length)
      for (const slug of slugs) expect(slug, `${study.slug}: cited slug`).toMatch(/^[a-z0-9-]{1,120}$/)
    }
  })

  it('every case study has its own URL', () => {
    const slugs = caseStudies.map((study) => study.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const slug of slugs) {
      // The slug goes straight into the URL, so a character outside this table is a URL that needs encoding, which would
      // have two spellings and therefore two pages in the eyes of a crawler.
      expect(slug, `${slug}: slug is not ASCII kebab-case`).toMatch(/^[a-z0-9-]{1,80}$/)
    }
  })

  it('contains no markdown syntax, because the page renders plain strings', () => {
    // The page pours each paragraph into a <p>, without a markdown pipeline: a string written `**like this**` or with
    // backticks around a function name would show the asterisks and backticks on screen.
    const offenders: string[] = []
    for (const study of caseStudies) {
      const blocks = [...study.problem, ...study.constraints, ...study.solution, ...study.ifRedone, study.summary, study.title]
      for (const text of blocks) {
        if (text.includes('**') || text.includes('`')) offenders.push(`${study.slug}: ${text.slice(0, 60)}`)
      }
    }

    expect(offenders).toEqual([])
  })

  it('does not mention the removed /projects path', () => {
    // The old project section was removed because it contained a system built for an employer. The case study page is the
    // place where it is easiest for it to crawl back under another name, so this blocks the path name too.
    expect(JSON.stringify(caseStudies)).not.toContain('/projects')
  })

  it('the verification date is written in ISO form and is not in the future', () => {
    for (const study of caseStudies) {
      expect(study.lastVerified, `${study.slug}`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      // A date in the future means someone typed an intended date and not the date the commands were rerun.
      expect(Date.parse(study.lastVerified)).toBeLessThanOrEqual(Date.now())
    }
  })

  it('measurements that cite a file point at a file that exists in the repo', () => {
    // A `source` pointing at a file that does not exist is a fake source: worse than no source, because it looks checked.
    // Only sources that clearly look like a path in the repo are considered.
    const root = join(process.cwd(), '..')
    const referenced = caseStudies
      .flatMap((s) => s.results.map((r) => r.source))
      .flatMap((src) => src.match(/(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|yml|yaml|md|sql|txt|xml)/g) ?? [])

    expect(referenced.length, 'no source points to a file: is the regex broken?').toBeGreaterThan(0)
    expect(referenced.filter((rel) => !existsSync(join(root, rel)))).toEqual([])
  })
})
