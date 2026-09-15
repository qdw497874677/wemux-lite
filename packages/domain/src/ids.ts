declare const idBrand: unique symbol

export type Id<Name extends string> = string & {
  readonly [idBrand]: Name
}

export type UserId = Id<'UserId'>
export type TeamId = Id<'TeamId'>
export type ProjectId = Id<'ProjectId'>
export type RepositoryId = Id<'RepositoryId'>
export type WorkerId = Id<'WorkerId'>
export type WorkspaceId = Id<'WorkspaceId'>
export type SessionId = Id<'SessionId'>
export type MessageId = Id<'MessageId'>
export type CommandId = Id<'CommandId'>
export type TurnId = Id<'TurnId'>
export type ToolCallId = Id<'ToolCallId'>
export type AuditEntryId = Id<'AuditEntryId'>
export type CredentialId = Id<'CredentialId'>
