import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'

const component = await fs.readFile(new URL('../src/components/ui/ai-prompt-input.tsx', import.meta.url), 'utf8')
const conversation = await fs.readFile(new URL('../src/features/sessions/conversation.tsx', import.meta.url), 'utf8')
const styles = await fs.readFile(new URL('../src/styles.css', import.meta.url), 'utf8')

test('session composer uses the reusable AI prompt component with authoritative binding', () => {
  assert.match(conversation, /<AiPromptInput/)
  assert.match(conversation, /modelLabel=\{session\.modelId \|\| 'Agent 默认模型'\}/)
  assert.match(conversation, /agentLabel=\{session\.agentKey\}/)
  assert.match(component, /Agent and Model when a Session is created/)
  assert.match(component, /会话创建后，智能体与模型保持固定/)
  assert.match(component, /Link2/)
  assert.doesNotMatch(component, /DEFAULT_AI_MODELS|opus-4\.5|gpt-5|gemini-2\.5/)
})

test('AI prompt keeps pending sends editable while disabling duplicate submission', () => {
  assert.match(component, /disabled=\{disabled\}/)
  assert.match(conversation, /submitDisabled=\{!canSend \|\| state\.pending\}/)
  assert.match(conversation, /status=\{state\.pending \? 'loading' : 'idle'\}/)
  assert.doesNotMatch(conversation, /disabled=\{state\.pending\}/)
})

test('AI prompt preserves desktop Enter and Shift+Enter behavior', () => {
  assert.match(component, /event\.key !== 'Enter' \|\| event\.shiftKey \|\| event\.nativeEvent\.isComposing/)
  assert.match(component, /window\.matchMedia\('\(pointer: fine\)'\)\.matches/)
})

test('AI prompt has responsive and accessibility fallbacks', () => {
  assert.match(component, /aria-invalid=\{Boolean\(error\)/)
  assert.match(component, /role=\{error \? 'alert' : 'status'\}/)
  assert.match(styles, /@media \(max-width: 639px\)/)
  assert.match(styles, /@media \(prefers-reduced-transparency: reduce\)/)
})
