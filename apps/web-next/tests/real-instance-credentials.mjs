import { readFile } from 'node:fs/promises'

export async function readAcceptanceCredentials(env = process.env, input = process.stdin) {
  try {
    const stdin = env.WEMUX_NEXT_LOGIN_STDIN === '1'
    if (stdin === Boolean(env.WEMUX_NEXT_LOGIN_FILE)) throw Error()
    let text
    if (stdin) {
      const chunks = []; let bytes = 0
      for await (const chunk of input) {
        const buffer = Buffer.from(chunk); bytes += buffer.length
        if (bytes > 65536) throw Error()
        chunks.push(buffer)
      }
      text = Buffer.concat(chunks).toString('utf8')
    } else text = await readFile(env.WEMUX_NEXT_LOGIN_FILE, 'utf8')
    if (Buffer.byteLength(text) > 65536) throw Error()
    const value = JSON.parse(text)
    if (!value || typeof value.login !== 'string' || !value.login.trim() || typeof value.password !== 'string' || !value.password.trim()) throw Error()
    return { login: value.login, password: value.password }
  } catch { throw Error('Invalid acceptance credential input (contents withheld).') }
}
