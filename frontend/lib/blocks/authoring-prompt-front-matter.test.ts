import { describe, expect, it } from 'vitest'
import { frontMatterReference } from './authoring-prompt'

/**
 * Two things the blind authoring test of round 2 found the guide silent about, both facts of the importer and the post rules:
 * a post cannot be published without a category (the backend refuses with POST_NOT_PUBLISHABLE), and the description of a series is written in every part, because the parts can arrive in any order
 * and an empty description of a series that exists is filled from whichever part comes.
 */
describe('the front matter reference of the authoring prompt', () => {
  const reference = frontMatterReference()

  it('says that a post cannot be published without a category and who then chooses it', () => {
    const row = reference.split('\n').find((line) => line.startsWith('| `category`'))
    expect(row).toContain('A post cannot be published without a category')
    expect(row).toContain('the administrator chooses one in the editor')
  })

  it('describes the cover and its alt text as a package image that becomes the cover and replaces an existing one', () => {
    const lines = reference.split(String.fromCharCode(10))
    const cover = lines.find((line) => line.startsWith('| `cover`'))
    const alt = lines.find((line) => line.startsWith('| `cover_alt`'))
    expect(cover).toContain('assets/cover.png')
    expect(cover).toContain('JPEG, PNG or WebP')
    expect(cover).toContain('inside a package')
    expect(cover).toContain('becomes the cover of the article')
    expect(cover).toContain('replaces the cover that an existing article already has')
    expect(cover).not.toContain('keeps it')
    expect(alt).toContain('300 characters')
    expect(alt).toContain('Write `cover_alt`')
    expect(alt).toContain('alternative text of the cover')
    expect(`${cover}${alt}`).not.toMatch(/[<>]/)
  })

  it('says that a cover in a plain Markdown file and a cover path that is not in the package are problems', () => {
    const cover = reference.split(String.fromCharCode(10)).find((line) => line.startsWith('| `cover`'))
    expect(cover).toContain('in a plain Markdown file a `cover` line is a problem')
    expect(cover).toContain('A path that is not in the package is a problem')
  })

  it('tells the author to write the series description in every part', () => {
    const row = reference.split('\n').find((line) => line.startsWith('| `series_description`'))
    expect(row).toContain('the parts can arrive in any order')
    expect(row).toContain('Write the same `series_description` line in every part')
  })

  it('tells that an empty description of a series that exists is filled and a non-empty one is never changed', () => {
    const row = reference.split(String.fromCharCode(10)).find((line) => line.startsWith('| `series_description`'))
    expect(row).toContain('creates the series')
    expect(row).toContain('fills the empty description of a series that exists, from any part')
    expect(row).toContain('never changes a description that is not empty')
    expect(row).toContain('an empty line writes nothing')
    expect(row).not.toContain('it is ignored')
    expect(row).not.toMatch(/[<>]/)
  })
})
