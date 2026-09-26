import React from 'react'
import { createRoot } from 'react-dom/client'
import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { Popover as BasePopover } from '@base-ui/react/popover'
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from '../src/components/ui/dialog.tsx'
import { PromptInput, PromptInputSubmit, PromptInputTextarea } from '../src/components/ai-elements/prompt-input.tsx'

function Harness() {
  return (
    <main>
      <Dialog>
        <DialogTrigger>打开 Radix 对话框</DialogTrigger>
        <DialogContent><DialogTitle>Radix 对话框</DialogTitle><DialogClose>关闭 Radix 对话框</DialogClose></DialogContent>
      </Dialog>

      <BaseDialog.Root>
        <BaseDialog.Trigger>打开 Base UI 对话框</BaseDialog.Trigger>
        <BaseDialog.Portal>
          <BaseDialog.Backdrop style={{ position: 'fixed', inset: 0 }} />
          <BaseDialog.Viewport style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center' }}>
            <BaseDialog.Popup data-testid="base-dialog" style={{ position: 'relative', zIndex: 1 }}>
              <BaseDialog.Title>Base UI 对话框</BaseDialog.Title>
              <BaseDialog.Close>关闭 Base UI 对话框</BaseDialog.Close>
            </BaseDialog.Popup>
          </BaseDialog.Viewport>
        </BaseDialog.Portal>
      </BaseDialog.Root>

      <BasePopover.Root>
        <BasePopover.Trigger>打开 Base UI 浮层</BasePopover.Trigger>
        <BasePopover.Portal>
          <BasePopover.Positioner>
            <BasePopover.Popup data-testid="base-popover">Base UI 浮层内容</BasePopover.Popup>
          </BasePopover.Positioner>
        </BasePopover.Portal>
      </BasePopover.Root>

      <PromptInput onSubmit={() => undefined}>
        <PromptInputTextarea aria-label="AI Elements 输入框" />
        <PromptInputSubmit />
      </PromptInput>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Harness />)
