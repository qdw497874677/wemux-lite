import type { HTMLAttributes } from 'react'
import type { UIMessage } from 'ai'
import { cn } from '../../lib/utils.ts'

export type MessageProps = HTMLAttributes<HTMLDivElement> & { from: UIMessage['role'] }

export function Message({ className, from, ...props }: MessageProps) {
  return <div className={cn('group flex w-full flex-col gap-1.5', from === 'user' ? 'is-user ml-auto max-w-[85%] items-end sm:max-w-[78%]' : 'is-assistant max-w-full', className)} {...props} />
}

export function MessageContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex min-w-0 max-w-full flex-col gap-1.5 overflow-hidden text-sm leading-6', 'group-[.is-user]:ml-auto group-[.is-user]:w-fit group-[.is-user]:rounded-xl group-[.is-user]:rounded-br-md group-[.is-user]:bg-accent group-[.is-user]:px-3.5 group-[.is-user]:py-2.5 group-[.is-user]:text-accent-foreground group-[.is-user]:shadow-xs', 'group-[.is-assistant]:w-full group-[.is-assistant]:bg-transparent group-[.is-assistant]:py-1', className)} {...props} />
}
