import type { RouteDescriptor, RouteParams } from './types.ts'

interface CompiledPattern {
  readonly expression: RegExp
  readonly names: readonly string[]
}

const compiled = new Map<string, CompiledPattern>()

const compilePattern = (pattern: string): CompiledPattern => {
  const existing = compiled.get(pattern)
  if (existing) return existing
  const names: string[] = []
  const source = pattern === '/' ? '/' : pattern.split('/').map(segment => {
    if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const optional = segment.endsWith('?')
    names.push(segment.slice(1, optional ? -1 : undefined))
    return optional ? '([^/]+)?' : '([^/]+)'
  }).join('/')
  const value = { expression: new RegExp(`^${source}$`), names }
  compiled.set(pattern, value)
  return value
}

export function matchRoutePattern(pattern: string, path: string): RouteParams | null {
  const { expression, names } = compilePattern(pattern)
  const match = expression.exec(path)
  if (!match) return null
  return Object.fromEntries(names.flatMap((name, index) => match[index + 1] === undefined ? [] : [[name, decodeURIComponent(match[index + 1])]]))
}

export function findRoute(routes: readonly RouteDescriptor[], method: string | undefined, path: string): { route: RouteDescriptor; params: RouteParams } | null {
  for (const route of routes) {
    if (route.method !== method) continue
    const params = matchRoutePattern(route.pattern, path)
    if (params) return { route, params }
  }
  return null
}
