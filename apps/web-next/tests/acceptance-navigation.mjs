// Track only explicit acceptance navigations, never infer lifecycle from a URL.
export function observeAcceptanceNavigation(page, trace = () => {}) {
  let epoch = 0, navigation
  const started = new WeakMap(), pending = new Set(), requestNavigations = new WeakMap()
  const snapshot = (evidence, request) => evidence && ({ confirmed: evidence.confirmed && evidence.succeeded, method: evidence.method, fromEpoch: evidence.fromEpoch, toEpoch: evidence.toEpoch, requestWasPending: evidence.requests.has(request) })
  page.on('request', request => { started.set(request, epoch); pending.add(request) })
  page.on('requestfinished', request => pending.delete(request))
  return {
    epoch: () => epoch,
    startEpoch: request => started.get(request),
    snapshot(request) {
      const evidence = requestNavigations.get(request) ?? navigation
      return evidence && { ...snapshot(evidence, request), confirmed: evidence.confirmed }
    },
    failure(request, report) {
      pending.delete(request)
      const evidence = requestNavigations.get(request)
      const classify = () => report(snapshot(evidence, request))
      // requestfailed precedes framenavigated in Chromium. Keep the particular
      // navigation alive until it settles, without accepting an unconfirmed abort.
      if (evidence && !evidence.settled) evidence.reports.push(classify)
      else classify()
    },
    async navigate(method, url) {
      const fromEpoch = epoch
      const evidence = { confirmed: false, succeeded: false, settled: false, reports: [], method, fromEpoch, toEpoch: fromEpoch + 1, requests: new Set(pending) }
      for (const request of pending) {
        if (started.get(request) === fromEpoch && !requestNavigations.has(request)) requestNavigations.set(request, evidence)
      }
      navigation = evidence
      trace({ event: 'navigation-start', method, fromEpoch, toEpoch: evidence.toEpoch })
      const confirm = frame => {
        if (frame === page.mainFrame() && !evidence.confirmed) {
          epoch = evidence.toEpoch
          evidence.confirmed = true
          trace({ event: 'main-frame-confirmed', method, fromEpoch, toEpoch: evidence.toEpoch })
        }
      }
      page.on('framenavigated', confirm)
      // Intent is not a document transition: the old document can still issue
      // requests until main-frame commit. Do not label those as the new epoch.
      try {
        const response = await page[method](url)
        evidence.succeeded = true
        return response
      } finally {
        evidence.settled = true
        trace({ event: 'navigation-settled', method, fromEpoch, toEpoch: evidence.toEpoch, confirmed: evidence.confirmed, succeeded: evidence.succeeded })
        page.off('framenavigated', confirm)
        for (const report of evidence.reports) report()
        evidence.reports.length = 0
      }
    },
  }
}
