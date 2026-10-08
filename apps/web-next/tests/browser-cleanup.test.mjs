import assert from 'node:assert/strict'
import test from 'node:test'
import { runBrowserAcceptance } from './browser-cleanup.mjs'

function fixture(overrides = {}) {
  const calls = [], reports = [], results = []
  const options = {
    runScenarios: async () => { calls.push('scenarios') },
    closeBrowser: async () => { calls.push('browser') },
    closeServer: async () => { calls.push('server') },
    verifyDiagnostics: () => { calls.push('diagnostics') },
    evidence: ['events', 'diagnostics'].map(stage => ({ stage, write: async () => { calls.push(stage) } })),
    writeResult: async result => { calls.push('result'); results.push(result) },
    reportFailure: (stage, error) => { reports.push({ stage, error }) },
    ...overrides,
  }
  return { calls, reports, results, options }
}

test('scenario identity/cause survives both close rejections; all evidence attempted once', async () => {
  const cause = new Error('original cause'), primary = new Error('scenario', { cause })
  const browser = new Error('browser close'), server = new Error('server close'), evidence = new Error('events write')
  const f = fixture()
  f.options.runScenarios = async () => { f.calls.push('scenarios'); throw primary }
  f.options.closeBrowser = async () => { f.calls.push('browser'); throw browser }
  f.options.closeServer = async () => { f.calls.push('server'); throw server }
  f.options.evidence[0].write = async () => { f.calls.push('events'); throw evidence }
  await assert.rejects(runBrowserAcceptance(f.options), error => error === primary && error.cause === cause)
  assert.deepEqual(f.calls, ['scenarios', 'browser', 'server', 'diagnostics', 'events', 'diagnostics', 'result'])
  assert.deepEqual(f.reports.map(item => item.error), [primary, browser, server, evidence])
  assert.equal(f.results.length, 1)
  assert.equal(f.results[0].passed, false)
})

test('late teardown diagnostics cannot produce a passing result', async () => {
  const late = new Error('late unexpected request failure'), diagnostics = []
  const f = fixture()
  f.options.closeServer = async () => { diagnostics.push(late) }
  f.options.verifyDiagnostics = () => { if (diagnostics.length) throw diagnostics[0] }
  await assert.rejects(runBrowserAcceptance(f.options), error => error === late)
  assert.equal(f.results[0].passed, false)
  assert.equal(f.results[0].failures[0].stage, 'diagnostics')
})

test('evidence rejection does not skip later evidence or overwrite result', async () => {
  const failure = new Error('events write failed')
  const f = fixture()
  f.options.evidence[0].write = async () => { f.calls.push('events'); throw failure }
  await assert.rejects(runBrowserAcceptance(f.options), error => error === failure)
  assert.deepEqual(f.calls.slice(-3), ['events', 'diagnostics', 'result'])
  assert.equal(f.results.length, 1)
  assert.equal(f.results[0].passed, false)
  assert.deepEqual(f.reports, [{ stage: 'events', error: failure }])
})

test('result write failure is surfaced and never retried', async () => {
  const failure = new Error('result write failed')
  const f = fixture()
  f.options.writeResult = async () => { f.calls.push('result'); throw failure }
  await assert.rejects(runBrowserAcceptance(f.options), error => error === failure)
  assert.equal(f.calls.filter(call => call === 'result').length, 1)
  assert.deepEqual(f.reports, [{ stage: 'result', error: failure }])
})

test('cleanup alone fails the run and successful completion writes one passing result last', async () => {
  const failure = new Error('close failed'), failed = fixture()
  failed.options.closeBrowser = () => { throw failure }
  await assert.rejects(runBrowserAcceptance(failed.options), error => error === failure)
  assert.equal(failed.results[0].passed, false)
  const success = fixture()
  await runBrowserAcceptance(success.options)
  assert.deepEqual(success.results, [{ passed: true, failures: [] }])
  assert.equal(success.calls.at(-1), 'result')
})
