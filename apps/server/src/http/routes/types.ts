import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LoginSession } from '@wemux/server-domain'
import type { AuthenticationService, RequestAccess, RequestCredential } from '../../application/auth.ts'
import type { AccountLifecycleService } from '../../application/account-lifecycle-service.ts'
import type { AccountSecurityService } from '../../application/account-security-service.ts'
import type { CanvasCollaborationService } from '../../application/canvas-collaboration-service.ts'
import type { CanvasLayoutService } from '../../application/canvas-layout-service.ts'
import type { ConnectorService } from '../../application/connector-service.ts'
import type { ChannelService } from '../../application/channel-service.ts'
import type { ChannelRouter } from '../../application/channel-router.ts'
import type { ChannelOutbox } from '../../application/channel-outbox.ts'
import type { GenericWebhookAdapter } from '../../channels/generic-webhook-adapter.ts'
import type { FeishuAdapter } from '../../channels/feishu/adapter.ts'
import type { CapabilityService } from '../../application/capability-service.ts'
import type { EmailRegistrationService } from '../../application/email-registration.ts'
import type { GoogleAuthenticationService } from '../../application/google-authentication.ts'
import type { IdentityService } from '../../application/identity-service.ts'
import type { InstanceSettingsService } from '../../application/instance-settings.ts'
import type { MailSettings } from '../../application/mail/email-delivery.ts'
import type { PersonalAccessTokenService } from '../../application/personal-access-token-service.ts'
import type { ProjectAccessService } from '../../application/project-access-service.ts'
import type { ServerService } from '../../application/server-service.ts'
import type { SessionAccessService } from '../../application/session-access-service.ts'
import type { SessionLineageService } from '../../application/session-lineage-service.ts'
import type { SessionFileService } from '../../application/session-file-service.ts'
import type { SessionTerminalService } from '../../application/session-terminal-service.ts'
import type { TaskService } from '../../application/task-service.ts'
import type { TeamService } from '../../application/team-service.ts'
import type { WorkerAccessService } from '../../application/worker-access-service.ts'
import type { CanvasCollaborationStreams } from '../canvas-collaboration-sse.ts'
import type { ProjectStreams } from '../project-sse.ts'
import type { SessionStreams } from '../sse.ts'
import type { TerminalStreams } from '../terminal-sse.ts'
import type { StaticSite } from '../static.ts'
import type { WorkerDownloads } from '../worker-downloads.ts'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
export type RouteAuth = 'public' | 'worker' | 'capability' | 'authenticated' | 'task' | 'admin'
export type RouteParams = Readonly<Record<string, string>>

export interface WorkerControl { disconnectWorker(workerId: import('@wemux/domain').WorkerId): void }

export interface HttpHandlerOptions {
  readonly service: ServerService
  readonly auth: AuthenticationService
  readonly streams: SessionStreams
  readonly capabilities?: CapabilityService
  readonly downloads?: WorkerDownloads
  readonly control?: WorkerControl
  readonly staticSite?: StaticSite
  readonly tasks?: TaskService
  readonly projectStreams?: ProjectStreams
  readonly identity?: IdentityService | null
  readonly registration?: EmailRegistrationService | null
  readonly settings?: InstanceSettingsService | null
  readonly google?: GoogleAuthenticationService | null
  readonly lineage?: SessionLineageService | null
  readonly security?: AccountSecurityService | null
  readonly teams?: TeamService | null
  readonly mail?: MailSettings | null
  readonly projects?: ProjectAccessService | null
  readonly workerAccess?: WorkerAccessService | null
  readonly sessionAccess?: SessionAccessService | null
  readonly sessionFiles?: SessionFileService | null
  readonly sessionTerminals?: SessionTerminalService | null
  readonly terminalStreams?: TerminalStreams | null
  readonly personalAccessTokens?: PersonalAccessTokenService | null
  readonly lifecycle?: AccountLifecycleService | null
  readonly canvasCollaboration?: CanvasCollaborationService | null
  readonly canvasCollaborationStreams?: CanvasCollaborationStreams | null
  readonly canvasLayouts?: CanvasLayoutService | null
  readonly connectors?: ConnectorService | null
  readonly channels?: ChannelService | null
  readonly channelRouter?: ChannelRouter | null
  readonly channelOutbox?: ChannelOutbox | null
  readonly genericWebhook?: GenericWebhookAdapter | null
  readonly feishu?: FeishuAdapter | null
}

export interface RouteRequestContext extends HttpHandlerOptions {
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly url: URL
  readonly rawPath: string
  readonly path: string
  readonly method: string | undefined
  readonly bearer: string | undefined
  readonly loginSession: LoginSession | null
  readonly credential: RequestCredential
  readonly params: RouteParams
  readBody(): Promise<unknown>
  readRawBody(maximumBytes?: number): Promise<Buffer>
  json(status: number, data: unknown): void
  noContent(): void
  actor(access?: RequestAccess): ReturnType<AuthenticationService['taskActor']>
  operator(): Promise<Awaited<ReturnType<AuthenticationService['taskActor']>>>
}

export interface RouteDescriptor {
  readonly method: HttpMethod
  readonly pattern: string
  readonly auth?: RouteAuth
  readonly handler: (context: RouteRequestContext) => Promise<void> | void
}
