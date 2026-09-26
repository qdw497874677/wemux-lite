import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'

const component = await fs.readFile(new URL('../src/components/ai-elements/prompt-input.tsx', import.meta.url), 'utf8')
const conversation = await fs.readFile(new URL('../src/features/sessions/conversation.tsx', import.meta.url), 'utf8')
const styles = await fs.readFile(new URL('../src/styles.css', import.meta.url), 'utf8')

test('session composer uses AI Elements PromptInput with authoritative binding', () => {
  assert.match(conversation, /<PromptInput/)
  assert.match(conversation, /session\.agentKey/)
  assert.match(conversation, /session\.modelId \|\| 'Agent 默认模型'/)
  assert.match(conversation, /会话创建后，智能体与模型保持固定/)
  assert.doesNotMatch(component, /DEFAULT_AI_MODELS|opus-4\.5|gpt-5|gemini-2\.5/)
})

test('AI prompt keeps pending sends editable and turns submit into stop while running', () => {
  assert.match(conversation, /const running = session\.runtimeState === 'running' \|\| Boolean\(activeTurnId\)/)
  assert.match(conversation, /status=\{running \|\| commandPending === 'stop' \? 'streaming'/)
  assert.match(conversation, /onStop=\{running \? \(\) => void stop\(\) : undefined\}/)
  assert.match(conversation, /!canSend \|\| state\.pending \|\| !state\.draft\.trim\(\)/)
  assert.doesNotMatch(conversation, /<PromptInputTextarea[^>]*disabled=\{state\.pending\}/)
})

test('AI prompt preserves Enter submit and Shift+Enter newline behavior', () => {
  assert.match(component, /event\.key !== 'Enter' \|\| event\.shiftKey \|\| event\.nativeEvent\.isComposing/)
  assert.match(component, /event\.currentTarget\.form\?\.requestSubmit\(\)/)
})

test('AI prompt has responsive and accessibility fallbacks', () => {
  assert.match(conversation, /aria-invalid=\{Boolean\(state\.error\)/)
  assert.match(conversation, /role=\{state\.error \|\| notice\?\.tone === 'error' \? 'alert' : 'status'\}/)
  assert.match(conversation, /aria-disabled="true"/)
  assert.match(styles, /@media \(max-width: 639px\)/)
  assert.match(styles, /@media \(prefers-reduced-transparency: reduce\)/)
})
