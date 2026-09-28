import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_IMAGE_UPLOAD_BYTES, fileToBase64, imageUploadSubpath, uploadImageAttachments } from '../src/features/sessions/image-attachments.ts'

const attachment = (name, type, bytes) => {
  const file = new File([bytes], name, { type })
  return { id: name, file, name, type, size: file.size, url: `blob:${name}` }
}

test('image attachments use the workspace uploads convention, recognize HEIC, and preserve binary bytes', async () => {
  const item = attachment('shot.PNG', 'image/png', new Uint8Array([0, 1, 2, 254, 255]))
  const path = imageUploadSubpath(item, new Date(2030, 0, 2, 3, 4, 5))
  assert.match(path, /^uploads\/20300102-030405-[a-z0-9]{8}\.png$/)
  assert.equal(await fileToBase64(item.file), 'AAEC/v8=')
  assert.match(imageUploadSubpath(attachment('camera.HEIC', '', new Uint8Array([1])), new Date(2030, 0, 2, 3, 4, 5)), /\.heic$/)
})

test('upload returns markdown references and stops honestly on failure or oversized files', async () => {
  const calls = []
  const api = { writeSessionFile: async (sessionId, subpath, base64Content) => { calls.push({ sessionId, subpath, base64Content }); return { operation: 'write', subpath, size: 3 } } }
  const references = await uploadImageAttachments(api, 'session-1', [attachment('image.png', 'image/png', new Uint8Array([1, 2, 3]))])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].base64Content, 'AQID')
  assert.match(references[0], /^!\[image\.png\]\(uploads\/.*\.png\)$/)
  await assert.rejects(uploadImageAttachments(api, 'session-1', [attachment('large.png', 'image/png', new Uint8Array(MAX_IMAGE_UPLOAD_BYTES + 1))]), /超过 5 MB 限制/)
  await assert.rejects(uploadImageAttachments({ writeSessionFile: async () => { throw new Error('上传中断') } }, 'session-1', [attachment('fail.png', 'image/png', new Uint8Array([1]))]), /上传中断/)
})
