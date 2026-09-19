import { createContext, useContext, type ComponentProps } from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { cva } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/**
 * Tabs ported from TailGrids (MIT). Anatomy follows the source exactly: the root
 * owns the framed container, the list is wrapped so the pill surface can be put
 * on the inner element, and variant + direction travel through context (upstream
 * keeps the same split, radix owns focus and keyboard behaviour).
 *
 * `direction` matters in TailGrids: `horizontal` turns the root into a two-column
 * frame (flex gap-8 p-6) and the trigger into a full-pad button, `vertical` keeps
 * the classic underline/pill list. Same recipes, same compounds.
 *
 * `default` and `minimal` are the upstream variants. `plain` is a Wemux superset
 * for embedding tabs inside an existing panel: no outer border, no list wrapper.
 */
type TabsVariant = 'default' | 'minimal' | 'plain'
type TabsDirection = 'vertical' | 'horizontal'

const TabsContext = createContext<{ variant: TabsVariant; direction: TabsDirection }>({ variant: 'default', direction: 'vertical' })

function useTabsContext() {
  return useContext(TabsContext)
}

export function Tabs({
  className,
  variant = 'default',
  direction = 'vertical',
  ...props
}: ComponentProps<typeof TabsPrimitive.Root> & { variant?: TabsVariant; direction?: TabsDirection }) {
  return (
    <TabsContext.Provider value={{ variant, direction }}>
      <TabsPrimitive.Root
        className={cn(
          variant !== 'plain' && 'max-w-full rounded-xl border border-base-200',
          variant === 'minimal' && direction === 'vertical' && 'px-6 pt-3',
          direction === 'horizontal' && variant !== 'plain' && 'flex gap-8 p-6 max-sm:flex-wrap',
          className,
        )}
        {...props}
      />
    </TabsContext.Provider>
  )
}

export function TabsList({ className, variant: variantProp, ...props }: ComponentProps<typeof TabsPrimitive.List> & { variant?: TabsVariant }) {
  const { variant: contextVariant, direction } = useTabsContext()
  const variant = variantProp ?? contextVariant
  const list = (
    <TabsPrimitive.List
      className={cn(
        // 上游的 list 只是 `flex overflow-x-auto overflow-y-hidden`：不加 items-center，
        // 子项靠 stretch 对齐，这也决定了非激活 tab 的高度（加 items-center 会矮 2px）。
        'ring-focus flex overflow-x-auto overflow-y-hidden outline-none',
        direction === 'horizontal' && 'flex-col gap-2 max-sm:items-center sm:min-w-50',
        direction === 'vertical' && variant === 'default' && 'gap-1',
        direction === 'vertical' && variant === 'minimal' && 'gap-2',
        variant === 'plain' && 'w-fit gap-1 rounded-lg bg-background-soft-100 p-1',
        className,
      )}
      {...props}
    />
  )
  if (variant === 'plain') return list
  return (
    <div
      className={cn(
        'max-sm:w-full',
        direction === 'vertical' && 'border-b border-base-200 [&>div]:w-full',
        direction === 'vertical' && variant === 'default' && 'p-3 [&>div]:rounded-lg [&>div]:bg-background-soft-100 [&>div]:p-1',
      )}
    >
      {list}
    </div>
  )
}

const triggerVariants = cva(
  'ring-focus flex items-center gap-2 px-3 text-sm font-medium whitespace-nowrap text-text-100 outline-none transition focus-visible:ring-3 focus-visible:ring-primary-400/30 disabled:pointer-events-none [&>svg]:size-5 [&>svg]:text-current!',
  {
    variants: {
      variant: {
        default: '',
        minimal: '',
        plain: 'h-9 rounded-md data-[state=active]:bg-tab-active-background data-[state=active]:text-title-50 data-[state=active]:shadow-xs',
      },
      direction: {
        vertical: '',
        horizontal: 'rounded-lg p-3 hover:bg-tab-secondary-active-background hover:text-neutral-brand-color max-sm:w-full max-sm:justify-center',
      },
    },
    compoundVariants: [
      // 上游把尺寸/激活外观全部放在 compound 里：vertical 与 horizontal 的激活态不同，
      // 所以不能写成“基础类 + 方向修饰”，否则 horizontal 会继承 vertical 的 shadow。
      {
        variant: 'default',
        direction: 'vertical',
        className:
          'rounded-md py-2 hover:bg-tab-secondary-active-background hover:text-neutral-brand-color data-[state=active]:bg-tab-active-background data-[state=active]:text-title-50 data-[state=active]:shadow-xs',
      },
      {
        variant: 'minimal',
        direction: 'vertical',
        className:
          'py-3.5 hover:text-neutral-brand-color data-[state=active]:border-b-2 data-[state=active]:border-primary-500 data-[state=active]:text-neutral-brand-color',
      },
      { variant: 'default', direction: 'horizontal', className: 'data-[state=active]:bg-tab-secondary-active-background data-[state=active]:text-neutral-brand-color' },
      { variant: 'minimal', direction: 'horizontal', className: 'data-[state=active]:border data-[state=active]:border-primary-500 data-[state=active]:text-neutral-brand-color' },
    ],
    defaultVariants: { variant: 'default', direction: 'vertical' },
  },
)

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  const { variant, direction } = useTabsContext()
  return <TabsPrimitive.Trigger className={cn(triggerVariants({ variant, direction }), className)} {...props} />
}

const contentVariants = cva('ring-focus text-sm font-normal text-text-100 outline-none', {
  variants: {
    variant: {
      default: '',
      minimal: '',
      plain: 'mt-4',
    },
    direction: {
      vertical: 'py-6',
      horizontal: '',
    },
  },
  compoundVariants: [{ variant: 'default', direction: 'vertical', className: 'px-6' }],
  defaultVariants: { variant: 'default', direction: 'vertical' },
})

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  const { variant, direction } = useTabsContext()
  return <TabsPrimitive.Content className={cn(contentVariants({ variant, direction }), className)} {...props} />
}