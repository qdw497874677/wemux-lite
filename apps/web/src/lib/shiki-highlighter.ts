import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'
import wasm from 'shiki/wasm'
import { LruCache, HIGHLIGHT_CACHE_LIMIT, codeHash, type HighlightedLine, type SupportedSyntaxLanguage, type SyntaxTheme } from './syntax-highlighting.ts'

const languageLoaders = {
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  bash: () => import('@shikijs/langs/bash'),
  python: () => import('@shikijs/langs/python'),
  go: () => import('@shikijs/langs/go'),
  rust: () => import('@shikijs/langs/rust'),
  java: () => import('@shikijs/langs/java'),
  sql: () => import('@shikijs/langs/sql'),
  html: () => import('@shikijs/langs/html'),
  css: () => import('@shikijs/langs/css'),
  yaml: () => import('@shikijs/langs/yaml'),
  markdown: () => import('@shikijs/langs/markdown'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
} as const

type SupportedLanguage = keyof typeof languageLoaders

const highlightedCodeCache = new LruCache<string, HighlightedLine[]>(HIGHLIGHT_CACHE_LIMIT)
const languageLoadPromises = new Map<SupportedLanguage, Promise<void>>()
let highlighterPromise: Promise<HighlighterCore> | null = null

function getHighlighter() {
  highlighterPromise ??= createHighlighterCore({
    themes: [import('@shikijs/themes/vitesse-dark'), import('@shikijs/themes/vitesse-light')],
    langs: [],
    engine: createOnigurumaEngine(wasm),
  })
  return highlighterPromise
}

async function getHighlighterForLanguage(language: SupportedLanguage) {
  const highlighter = await getHighlighter()
  if (!highlighter.getLoadedLanguages().includes(language)) {
    let loadPromise = languageLoadPromises.get(language)
    if (!loadPromise) {
      loadPromise = highlighter.loadLanguage(languageLoaders[language]()).catch(error => {
        languageLoadPromises.delete(language)
        throw error
      })
      languageLoadPromises.set(language, loadPromise)
    }
    await loadPromise
  }
  return highlighter
}

export async function highlightCodeWithShiki(code: string, language: SupportedSyntaxLanguage, theme: SyntaxTheme): Promise<HighlightedLine[] | null> {
  const supportedLanguage = language as SupportedLanguage
  const cacheKey = `${language}:${theme}:${code.length}:${codeHash(code)}`
  const cached = highlightedCodeCache.get(cacheKey)
  if (cached) return cached
  try {
    const highlighter = await getHighlighterForLanguage(supportedLanguage)
    const result = highlighter.codeToTokens(code, {
      lang: supportedLanguage,
      theme: theme === 'dark' ? 'vitesse-dark' : 'vitesse-light',
    }).tokens
    highlightedCodeCache.set(cacheKey, result)
    return result
  } catch (error) {
    console.warn(`Code highlighting failed for language "${language}"; using plain text.`, error)
    return null
  }
}
