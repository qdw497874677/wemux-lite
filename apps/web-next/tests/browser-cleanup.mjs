// Injectable lifecycle for the controlled browser fixture; tests never start a browser/server.
export async function runBrowserAcceptance({ runScenarios, closeBrowser, closeServer, verifyDiagnostics, evidence, writeResult, reportFailure = (stage, error) => console.error(stage, error) }) {
  const failures = []
  async function attempt(stage, action) {
    try { await action() }
    catch (error) { failures.push({ stage, error }) }
  }
  await attempt('scenarios', runScenarios)
  await attempt('browser-close', closeBrowser)
  await attempt('server-close', closeServer)
  // Teardown can emit diagnostics. Neither validation nor evidence precedes it.
  await attempt('diagnostics', verifyDiagnostics)
  for (const artifact of evidence) await attempt(artifact.stage, artifact.write)
  // Exactly one result write: no optimistic PASS followed by a failure overwrite.
  await attempt('result', () => writeResult({ passed: failures.length === 0, failures: [...failures] }))
  for (const { stage, error } of [...failures]) {
    try { await reportFailure(stage, error) }
    catch (reportError) { console.error('failure-reporting', reportError) }
  }
  // Rethrow the original object (including its cause), not a cleanup replacement.
  if (failures.length) throw failures[0].error
}
