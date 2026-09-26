import type { HTMLAttributes } from 'react'
import type { UIMessage } from 'ai'
import { cn } from '../../lib/utils.ts'

export type MessageProps = HTMLAttributes<HTMLDivElement> & { from: UIMessage['role'] }

export function Message({ className, from, ...props }: MessageProps) {
  return <div className={cn('group flex w-full max-w-[95%] flex-col gap-2', from === 'user' ? 'is-user ml-auto items-end' : 'is-assistant', className)} {...props} />
}

export function MessageContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm leading-6', 'group-[.is-user]:ml-auto group-[.is-user]:rounded-3xl group-[.is-user]:rounded-br-lg group-[.is-user]:bg-gradient-to-br group-[.is-user]:from-indigo-500/25 group-[.is-user]:to-purple-500/20 group-[.is-user]:px-5 group-[.is-user]:py-3.5 group-[.is-user]:shadow-md group-[.is-user]:ring-1 group-[.is-user]:ring-indigo-400/20', 'group-[.is-assistant]:rounded-3xl group-[.is-assistant]:rounded-bl-lg group-[.is-assistant]:bg-card/80 group-[.is-assistant]:px-5 group-[.is-assistant]:py-4 group-[.is-assistant]:shadow-sm', className)} {...props} />
}
