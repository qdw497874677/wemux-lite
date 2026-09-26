import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LoginSession } from '@wemux/server-domain'
import type { AuthenticationService, RequestAccess, RequestCredential } from '../../application/auth.js'
import type { AccountLifecycleService } from '../../application/account-lifecycle-service.js'
import type { AccountSecurityService } from '../../application/account-security-service.js'
import type { CanvasCollaborationService } from '../../application/canvas-collaboration-service.js'
import type { CanvasLayoutService } from '../../application/canvas-layout-service.js'
import type { CapabilityService } from '../../application/capability-service.js'
import type { EmailRegistrationService } from '../../application/email-registration.js'
import type { GoogleAuthenticationService } from '../../application/google-authentication.js'
import type { IdentityService } from '../../application/identity-service.js'
import type { InstanceSettingsService } from '../../application/instance-settings.js'
import type { MailSettings } from '../../application/mail/email-delivery.js'
import type { PersonalAccessTokenService } from '../../application/personal-access-token-service.js'
import type { ProjectAccessService } from '../../application/project-access-service.js'
import type { ServerService } from '../../application/server-service.js'
import type { SessionAccessService } from '../../application/session-access-service.js'
import type { SessionLineageService } from '../../application/session-lineage-service.js'
import type { TaskService } from '../../application/task-service.js'
import type { TeamService } from '../../application/team-service.js'
import type { WorkerAccessService } from '../../application/worker-access-service.js'
import type { CanvasCollaborationStreams } from '../canvas-collaboration-sse.js'
import type { ProjectStreams } from '../project-sse.js'
import type { SessionStreams } from '../sse.js'
import type { StaticSite } from '../static.js'
import type { WorkerDownloads } from '../worker-downloads.js'

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
  readonly personalAccessTokens?: PersonalAccessTokenService | null
  readonly lifecycle?: AccountLifecycleService | null
  readonly canvasCollaboration?: CanvasCollaborationService | null
  readonly canvasCollaborationStreams?: CanvasCollaborationStreams | null
  readonly canvasLayouts?: CanvasLayoutService | null
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
