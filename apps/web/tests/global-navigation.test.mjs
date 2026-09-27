import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8')
const globalNavigation = appSource.slice(appSource.indexOf('const globalNavigation ='), appSource.indexOf('return <RunLayerContext.Provider'))

test('header does not duplicate the workbench and cluster global navigation', () => {
  assert.doesNotMatch(appSource, /aria-label="页面导航"/)
  assert.doesNotMatch(appSource, />工作台<\/button>/)
})

test('all unified sidebar destinations expose the active page state', () => {
  for (const destination of ['projects', 'teams', 'runtime', 'cluster', 'components', 'settings']) {
    assert.match(globalNavigation, new RegExp(`path: '/${destination}'`))
  }
  assert.match(globalNavigation, /aria-current=\{item\.active \? 'page' : undefined\}/)
  assert.match(globalNavigation, /isActive=\{item\.active\}/)
  assert.match(appSource, /<SidebarRail \/>/)
  assert.match(styles, /\[data-slot="sidebar"\]/)
})
