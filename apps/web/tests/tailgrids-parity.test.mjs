// TailGrids 对齐契约（分层回归）：
//   1. 配方层：我们组件的 base 类名集合 == 上游快照 + 已登记扩展，缺失项必须在白名单里；
//   2. 结构层：换过底层实现的组件，锁住必须出现的上游词组；
//   3. 偏差层：已登记的“写法不同但结果一致”的偏差必须还在（防止默默改回去）；
//   4. 不变量层：styles.css 的令牌值与基础层写法必须与上游一致。
//
// 参照快照在 tests/fixtures/tailgrids-parity.json，由
// scripts/tailgrids-parity/gen-fixture.mjs 按固定上游 commit 生成。
// 这里只做“读源码 + 集合比对”，不需要浏览器；像素/计算样式比对见 audit 报告里的工装。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const repo = new URL('../../../', import.meta.url)
const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/tailgrids-parity.json', import.meta.url), 'utf8'))
const read = (relative) => readFile(new URL(relative, repo), 'utf8')

const SYNTAX_ALIASES = [
  [/^data-\[invalid\]:/, 'data-invalid:'],
  [/^data-\[disabled\]:/, 'data-disabled:'],
  [/^data-\[state=([a-z]+)\]:/, 'data-$1:'],
]
const canonical = (token) => SYNTAX_ALIASES.reduce((acc, [from, to]) => acc.replace(from, to), token)

/** 与夹具生成器同一套抽取规则：cva 第一参 > cn 首段字面量 > const XClass。 */
const baseString = (source) => {
  const patterns = [
    /cva\(\s*['"`]([^'"`]+)['"`]/,
    /cn\(\s*\n?\s*['"`]([^'"`\n]{20,400})['"`]/,
    /const \w*[Cc]lass(?:Name)?\s*=\s*\n?\s*['"`]([^'"`]{20,400})['"`]/,
  ]
  for (const pattern of patterns) {
    const match = source.match(pattern)
    if (match) return match[1]
  }
  return null
}
const tokenize = (value) => (value ? value.trim().split(/\s+/) : [])

const sources = new Map()
const sourceOf = async (relative) => {
  if (!sources.has(relative)) sources.set(relative, await read(relative))
  return sources.get(relative)
}

test('夹具记录了上游来源与 commit，不是凭空写的对照', () => {
  assert.match(fixture._source.repo, /github\.com\/TailGrids\/tailgrids/)
  assert.match(fixture._source.commit, /^[0-9a-f]{40}$/)
  assert.equal(fixture._source.license, 'MIT')
  assert.ok(fixture._source.reference.includes(fixture._source.commit))
})

for (const [name, recipe] of Object.entries(fixture.recipes)) {
  test(`${name}: base 类名与上游一致（集合相等）`, async () => {
    const base = baseString(await sourceOf(recipe.ours))
    assert.ok(base, `${recipe.ours} 里找不到 base 配方串`)
    const live = tokenize(base).map(canonical)
    const documentedMissing = new Set(recipe.documentedMissing.map((entry) => canonical(entry.token)))

    const missing = recipe.baseTokens.filter((token) => !live.includes(token))
    if (recipe.tier === 'strict') {
      assert.deepEqual(
        missing.filter((token) => !documentedMissing.has(token)),
        [],
        `${name} 缺少上游类名且未登记原因: ${missing.join(' ')}`,
      )
    }
    for (const entry of recipe.documentedMissing) {
      assert.match(entry.reason, /.{10,}/, `${name} 的白名单项必须有原因`)
      assert.ok(missing.includes(canonical(entry.token)), `${name} 白名单项 ${entry.token} 现在已不缺失，应删除登记`)
    }

    const extras = [...new Set(live.filter((token) => !recipe.baseTokens.includes(token)))].sort()
    assert.deepEqual(
      extras,
      [...recipe.extensions].sort(),
      `${name} 多出未登记的类名（或登记的扩展已失效）: ${extras.join(' ')}`,
    )
    for (const token of recipe.forbidden) {
      assert.ok(!live.includes(token), `${name} 不应再出现 ${token}`)
    }
  })
}

test('结构层：换过实现的组件仍用上游词组', async () => {
  for (const [name, spec] of Object.entries(fixture.requiredTokens)) {
    const source = await sourceOf(spec.ours)
    for (const snippet of spec.tokens) {
      assert.ok(source.includes(snippet), `${name} 缺少上游词组: ${snippet}`)
    }
  }
})

test('偏差层：登记的写法差异仍在（每个偏差都要有原因）', async () => {
  assert.ok(fixture.deviations.length >= 3)
  for (const deviation of fixture.deviations) {
    const source = await sourceOf(deviation.ours)
    assert.ok(source.includes(deviation.oursSnippet), `${deviation.component} 的已登记写法变了: ${deviation.oursSnippet}`)
    assert.match(deviation.reason, /.{15,}/, `${deviation.component} 的偏差必须有原因`)
    assert.match(deviation.upstreamSnippet, /.{3,}/)
  }
})

test('基础层不变量：全局 border-color 不能再回来，表单控件不再被统一染色', async () => {
  const styles = await sourceOf('apps/web/src/styles.css')
  for (const rule of fixture.invariants.styles) {
    if (rule.contains) assert.ok(styles.includes(rule.contains), `styles.css 缺少: ${rule.contains}`)
    if (rule.notContains) assert.ok(!styles.includes(rule.notContains), `styles.css 不应包含: ${rule.notContains}`)
  }
})

test('图标层：浮层关闭按钮用上游 Close 图标，不退回 lucide 近似图标', async () => {
  for (const rule of fixture.invariants.icons) {
    const source = await sourceOf(rule.path)
    if (rule.contains) assert.ok(source.includes(rule.contains), `${rule.path} 缺少: ${rule.contains}`)
    if (rule.notContains) assert.ok(!source.includes(rule.notContains), `${rule.path} 不应包含: ${rule.notContains}`)
  }
})

test('令牌层：深色与浅色覆盖值与上游主题文件一致', async () => {
  const styles = await sourceOf('apps/web/src/styles.css')
  const blockOf = (start) => {
    const from = styles.indexOf(start)
    assert.ok(from >= 0, `找不到 ${start}`)
    let depth = 0
    for (let index = styles.indexOf('{', from); index < styles.length; index += 1) {
      if (styles[index] === '{') depth += 1
      else if (styles[index] === '}') {
        depth -= 1
        if (depth === 0) return styles.slice(from, index + 1)
      }
    }
    throw new Error(`未闭合: ${start}`)
  }
  const dark = blockOf('@theme')
  const light = blockOf('@media (prefers-color-scheme: light)')
  for (const [token, value] of Object.entries(fixture.invariants.tokens)) {
    assert.ok(dark.includes(`${token}: ${value.dark};`), `深色缺少 ${token}: ${value.dark}`)
    assert.ok(light.includes(`${token}: ${value.light};`), `浅色缺少 ${token}: ${value.light}`)
  }
})