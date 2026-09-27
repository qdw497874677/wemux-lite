import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8')
const globalRail = appSource.slice(appSource.indexOf('const globalRail ='), appSource.indexOf('return <RunLayerContext.Provider'))

test('header does not duplicate the workbench and cluster global navigation', () => {
  assert.doesNotMatch(appSource, /aria-label="页面导航"/)
  assert.doesNotMatch(appSource, />工作台<\/button>/)
})

test('all global rail destinations expose the active page state', () => {
  for (const destination of ['projects', 'teams', 'runtime', 'cluster', 'components', 'settings']) {
    assert.match(globalRail, new RegExp(`href="/${destination}"[^>]+aria-current=`))
  }
  assert.equal(globalRail.match(/aria-current=/g)?.length, 6)
  assert.equal(globalRail.match(/bg-accent text-foreground/g)?.length, 6)
  assert.match(styles, /\.global-rail a\[aria-current="page"\] \{ background: var\(--color-accent\); color: var\(--color-foreground\); \}/)
})
