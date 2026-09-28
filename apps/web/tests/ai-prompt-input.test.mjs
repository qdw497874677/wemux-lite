import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'

const component = await fs.readFile(new URL('../src/components/ai-elements/prompt-input.tsx', import.meta.url), 'utf8')
const conversation = await fs.readFile(new URL('../src/features/sessions/conversation.tsx', import.meta.url), 'utf8')
const imageAttachments = await fs.readFile(new URL('../src/features/sessions/image-attachments.ts', import.meta.url), 'utf8')
const styles = await fs.readFile(new URL('../src/styles.css', import.meta.url), 'utf8')

test('session composer uses AI Elements PromptInput with authoritative binding', () => {
  assert.match(conversation, /<PromptInput/)
  assert.match(conversation, /session\.agentKey/)
  assert.match(conversation, /useState\(session\.modelId\)/)
  assert.match(conversation, /该智能体不支持运行中切换/)
  assert.doesNotMatch(component, /DEFAULT_AI_MODELS|opus-4\.5|gpt-5|gemini-2\.5/)
})

test('AI prompt keeps pending sends editable and turns submit into stop while running', () => {
  assert.match(conversation, /const running = session\.runtimeState === 'running' \|\| Boolean\(activeTurnId\)/)
  assert.match(conversation, /status=\{running \|\| commandPending === 'stop' \? 'streaming'/)
  assert.match(conversation, /onStop=\{running \? \(\) => void stop\(\) : undefined\}/)
  assert.match(conversation, /!canSend \|\| state\.pending \|\| \(!state\.draft\.trim\(\) && !attachments\.files\.length\)/)
  assert.doesNotMatch(conversation, /<PromptInputTextarea[^>]*disabled=\{state\.pending\}/)
})

test('AI prompt preserves Enter submit and Shift+Enter newline behavior', () => {
  assert.match(component, /event\.key !== 'Enter' \|\| event\.shiftKey \|\| event\.nativeEvent\.isComposing/)
  assert.match(component, /event\.currentTarget\.form\?\.requestSubmit\(\)/)
})

test('AI prompt accepts selected, pasted, and dropped images and uploads before sending', () => {
  assert.match(component, /event\.clipboardData\.files/)
  assert.match(component, /event\.dataTransfer\.files/)
  assert.match(conversation, /uploadImageAttachments\(api!, session\.id, images\)/)
  assert.match(conversation, /attachments\.clear\(\)/)
  assert.match(conversation, /图片上传失败|附件仍保留/)
  assert.match(imageAttachments, /MAX_IMAGE_UPLOAD_BYTES = 5 \* 1024 \* 1024/)
  assert.match(imageAttachments, /`uploads\/\$\{stamp\}-\$\{randomId\(\)/)
  assert.match(imageAttachments, /references\.push\(`!\[\$\{attachment\.name \|\| 'image'\}\]\(\$\{written\.subpath\}\)`\)/)
})

test('AI prompt has responsive and accessibility fallbacks', () => {
  assert.match(conversation, /aria-invalid=\{Boolean\(state\.error\)/)
  assert.match(conversation, /role=\{state\.error \|\| notice\?\.tone === 'error' \? 'alert' : 'status'\}/)
  assert.match(conversation, /PromptInputActionAddAttachments kind="file"/)
  assert.match(styles, /@media \(max-width: 639px\)/)
  assert.match(styles, /@media \(prefers-reduced-transparency: reduce\)/)
})
