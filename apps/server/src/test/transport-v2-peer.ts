import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import type { MessageId, Timestamp, WorkerId } from '@wemux/domain'
import type {
  ServerHelloFrame,
  ServerPayload,
  ServerToWorkerFrame,
  WorkerPayload,
  WorkerToServerFrame,
} from '@wemux/wire-protocol'

export class TransportV2Peer {
  readonly messages: ServerPayload[] = []
  readonly frames: ServerToWorkerFrame[] = []
  private workerEpoch: string = randomUUID()
  private workerSeq = 0
  private serverAckThrough = 0
  private hello: ServerHelloFrame | null = null

  constructor(readonly ws: WebSocket, private readonly workerId: string) {
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as ServerToWorkerFrame
      this.frames.push(frame)
      if (frame.frameType === 'transport.hello') {
        this.hello = frame
        this.workerEpoch = frame.authoritativeCursors.workerToServer.deliveryEpoch
        this.workerSeq = frame.authoritativeCursors.workerToServer.ackThrough
        this.serverAckThrough = frame.authoritativeCursors.serverToWorker.ackThrough
        return
      }
      if (frame.frameType === 'data') {
        this.messages.push(frame.payload)
        if (frame.durability === 'durable' && frame.directionSeq > this.serverAckThrough) {
          this.serverAckThrough = frame.directionSeq
          this.raw({ frameType: 'transport.ack', deliveryEpoch: frame.deliveryEpoch, ackThrough: frame.directionSeq })
        }
      }
    })
  }

  async connect(metadata: { readonly name: string; readonly workerVersion?: string; readonly platform?: string; readonly architecture?: string }): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN) await once(this.ws, 'open')
    this.raw({
      frameType: 'transport.hello', side: 'worker',
      transport: { supportedMajors: [2], preferredMinorByMajor: { '2': 0 } },
      adkProfiles: ['wemux.adk.v1'], features: [], workerId: this.workerId as WorkerId,
      workerVersion: metadata.workerVersion ?? 'test', name: metadata.name,
      platform: metadata.platform ?? 'linux', architecture: metadata.architecture ?? 'x64',
      resume: { logicalConnectionId: null, workerToServer: { deliveryEpoch: this.workerEpoch, ackThrough: this.workerSeq }, serverToWorker: null },
    })
    await this.waitForHello()
  }

  send(payload: Record<string, unknown>): void {
    this.workerSeq += 1
    this.raw({
      frameType: 'data', durability: 'durable', deliveryEpoch: this.workerEpoch,
      directionSeq: this.workerSeq, messageId: randomUUID() as MessageId,
      lane: payload.type === 'event' || payload.type === 'sync' ? 'journal' : 'control',
      payloadVersion: 'wemux.worker.payload.v1', expiresAt: null, payload: payload as unknown as WorkerPayload,
    })
  }

  raw(frame: WorkerToServerFrame): void { this.ws.send(JSON.stringify(frame)) }

  async wait(predicate: (message: ServerPayload) => boolean): Promise<ServerPayload> {
    for (let i = 0; i < 200; i++) {
      const index = this.messages.findIndex(predicate)
      if (index >= 0) return this.messages.splice(index, 1)[0]!
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`Timed out waiting for Server payload: ${JSON.stringify(this.frames)}`)
  }

  async waitForFrame(predicate: (frame: ServerToWorkerFrame) => boolean): Promise<ServerToWorkerFrame> {
    for (let i = 0; i < 200; i++) {
      const frame = this.frames.find(predicate)
      if (frame) return frame
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`Timed out waiting for Server frame: ${JSON.stringify(this.frames)}`)
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return
    const done = once(this.ws, 'close')
    this.ws.close()
    await done
  }

  private async waitForHello(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (this.hello) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`Timed out waiting for transport.hello: ${JSON.stringify(this.frames)}`)
  }
}

export const timestamp = () => new Date().toISOString() as Timestamp
