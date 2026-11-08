import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Locator, Page } from '@playwright/test'
import { escapeRegExp } from './support/admin'
import { expect, test } from './support/fixtures'
import { msg } from './support/i18n'

/**
 * The Markdown profile import (/admin/settings/import): download the template, edit it, upload it, read the preview, write one
 * section and not another, see the public page change with no rebuild (the apply is a server action that clears the
 * `site-content` cache tag), then undo. The test leaves the site content as it found it: the import is undone at the end, and
 * a failed run undoes it in `finally`. Desktop only: nothing here depends on the viewport. The file always writes to `vi`, whatever
 * the language of the admin screens (`E2E_LOCALE`), because the file decides the language.
 */
test.beforeEach(() => {
  test.skip(test.info().project.name !== 'desktop', 'the journey does not depend on the viewport')
})

const P = 'Admin.settings.profileImport'
const CONTENT_LOCALE = 'vi'

/** Replace the value of `- field:` in the section with the English heading `heading`; comment blocks are skipped. */
function setField(text: string, heading: string, field: string, value: string): { text: string; line: number } {
  const lines = text.split('\n')
  let current = ''
  let inComment = false
  for (const [index, line] of lines.entries()) {
    if (inComment) {
      if (line.includes('-->')) inComment = false
      continue
    }
    if (line.startsWith('<!--')) {
      inComment = !line.includes('-->')
      continue
    }
    if (line.startsWith('# ')) current = line.slice(2).trim()
    else if (current === heading && line.startsWith(`- ${field}:`)) {
      lines[index] = `- ${field}: ${value}`
      return { text: lines.join('\n'), line: index + 1 }
    }
  }
  throw new Error(`The template has no "- ${field}:" line under "# ${heading}"`)
}

async function downloadTemplate(page: Page): Promise<string> {
  await page.goto('/admin/settings/import')
  await expect(page.getByRole('heading', { level: 1, name: msg(`${P}.page.title`) })).toBeVisible()
  await page.getByRole('combobox', { name: msg(`${P}.template.language`), exact: true }).selectOption(CONTENT_LOCALE)
  const downloading = page.waitForEvent('download')
  await page.getByRole('link', { name: msg(`${P}.template.download`), exact: true }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toBe(`site-profile-template-${CONTENT_LOCALE}.md`)
  const path = await download.path()
  const text = await readFile(path, 'utf8')
  expect(text.startsWith('---\n')).toBe(true)
  expect(text).toContain(`locale: ${CONTENT_LOCALE}`)
  return text
}

async function chooseFile(page: Page, text: string): Promise<void> {
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'site-profile.md', mimeType: 'text/markdown', buffer: Buffer.from(text, 'utf8') })
  await expect(page.getByText(msg(`${P}.preview.willWriteTo`, { language: msg('Admin.settings.locales.vi') }))).toBeVisible()
}

function sectionList(page: Page): Locator {
  return page.getByRole('list', { name: msg(`${P}.preview.listLabel`) })
}

function applyButton(page: Page, count: number): Locator {
  return page.getByRole('button', { name: msg(`${P}.apply`, { count }), exact: true })
}

/** The status label of one section card, accepting the states a fresh or a seeded database can give. */
function statusPattern(...states: ('new' | 'will_change' | 'unchanged')[]): RegExp {
  return new RegExp(states.map((state) => escapeRegExp(msg(`${P}.preview.status.${state}`))).join('|'))
}

async function undoLastImport(page: Page): Promise<void> {
  await page.getByRole('button', { name: msg(`${P}.undo.button`), exact: true }).click()
  await page.getByRole('button', { name: msg(`${P}.undo.confirm`), exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: msg(`${P}.status.undone`) })).toBeVisible()
}

test('importing a profile file changes the chosen sections only, shows on the public page, and can be undone', async ({
  adminPage: page,
}) => {
  test.setTimeout(180_000)
  const suffix = randomUUID().slice(0, 8)
  const personName = `Test Person ${suffix}`
  const siteName = `Test Site ${suffix}`
  let applied = false
  let undone = false
  try {
    let text = await downloadTemplate(page)
    text = setField(text, 'Identity', 'name', personName).text
    text = setField(text, 'Site', 'name', siteName).text
    await chooseFile(page, text)

    const list = sectionList(page)
    const identity = list.getByRole('listitem').filter({ has: page.getByRole('checkbox', { name: 'Identity', exact: true }) })
    await expect(identity).toContainText(statusPattern('new', 'will_change'))
    const identityCheck = list.getByRole('checkbox', { name: 'Identity', exact: true })
    const siteCheck = list.getByRole('checkbox', { name: 'Site', exact: true })
    await expect(identityCheck).toBeEnabled()
    await expect(identityCheck).toBeChecked()
    await expect(siteCheck).toBeEnabled()
    await expect(siteCheck).toBeChecked()

    // What the public page shows now, taken from the preview: the "before" of the changed name.
    const nameChange = identity.locator('li', { has: page.locator('code', { hasText: /^name$/ }) })
    const before = (await nameChange.locator('dd').first().innerText()).trim()
    await expect(nameChange.locator('dd').nth(1)).toHaveText(personName)

    await siteCheck.uncheck()
    await expect(siteCheck).not.toBeChecked()
    const checked = await list.getByRole('checkbox', { checked: true }).count()
    expect(checked).toBeGreaterThan(0)

    applied = true
    await applyButton(page, checked).click()
    await expect(page.getByRole('heading', { name: msg(`${P}.result.heading`), exact: true })).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: msg(`${P}.status.applied`) })).toBeVisible()
    await expect(
      page.getByRole('link', { name: msg(`${P}.result.viewSite`, { language: msg('Admin.settings.locales.vi') }) }),
    ).toBeVisible()

    // The public page of that language shows the new name at once (the action cleared the cache tag).
    await page.goto('/about')
    await expect(page.getByText(personName, { exact: true })).toBeVisible()

    // The section that was unchecked did not change: the site name is not in the home page title nor in the admin form.
    await page.goto('/')
    await expect(page).not.toHaveTitle(new RegExp(escapeRegExp(siteName)))
    await page.goto(`/admin/settings/site?locale=${CONTENT_LOCALE}`)
    await expect(page.getByLabel(msg('Admin.settings.site.name'), { exact: true })).not.toHaveValue(siteName)

    // Undo: the import page offers it again on load, and the old name is back.
    await page.goto('/admin/settings/import')
    await undoLastImport(page)
    undone = true
    await page.goto('/about')
    await expect(page.getByText(personName, { exact: true })).toHaveCount(0)
    if (before !== msg(`${P}.preview.none`)) await expect(page.getByText(before, { exact: true }).first()).toBeVisible()
  } finally {
    if (applied && !undone) {
      // Best effort: leave the content as it was found. The import page shows the undo button when the last import is undoable.
      await page.goto('/admin/settings/import')
      await undoLastImport(page).catch(() => {})
    }
  }
})

test('a file with a javascript: link shows the section and line of the error and cannot be applied', async ({
  adminPage: page,
}) => {
  test.setTimeout(120_000)
  const template = await downloadTemplate(page)
  const edited = setField(template, 'Contact', 'github', 'javascript:alert(1)')
  await chooseFile(page, edited.text)

  const list = sectionList(page)
  const contactCheck = page.getByRole('checkbox', { name: 'Contact', exact: true })
  await expect(list.getByRole('listitem').filter({ has: contactCheck })).toContainText(msg(`${P}.preview.status.error`))
  const where = ['Contact', msg(`${P}.preview.lineNumber`, { line: edited.line }), 'github'].join(', ')
  await expect(list.getByText(new RegExp(`^${escapeRegExp(where)}`))).toBeVisible()
  await expect(contactCheck).toBeDisabled()
  await expect(contactCheck).not.toBeChecked()

  // Other sections stay selectable; with none chosen the confirm button is disabled, and the file is never written.
  const checked = list.getByRole('checkbox', { checked: true })
  while ((await checked.count()) > 0) await checked.first().uncheck()
  await expect(applyButton(page, 0)).toBeDisabled()
})
