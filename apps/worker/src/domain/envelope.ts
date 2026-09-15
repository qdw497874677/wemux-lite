import { randomUUID } from 'node:crypto'
import type { MessageId } from '@wemux/domain'

export const envelope = () => ({ protocolVersion: 1 as const, messageId: randomUUID() as MessageId })
