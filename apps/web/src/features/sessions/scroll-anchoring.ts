export const SCROLL_BOTTOM_THRESHOLD_PX = 40

export interface ScrollAnchorState {
  isAtBottom: boolean
  unreadCount: number
  shouldScrollToBottom: boolean
}

type ScrollAnchorEvent =
  | { type: 'viewport-scrolled'; distanceFromBottom: number }
  | { type: 'content-added'; count: number }
  | { type: 'jump-to-bottom' }
  | { type: 'scroll-completed' }

export function isScrollViewportAtBottom(
  distanceFromBottom: number,
  threshold = SCROLL_BOTTOM_THRESHOLD_PX,
): boolean {
  return distanceFromBottom <= threshold
}

export function createScrollAnchorState({
  distanceFromBottom,
}: {
  distanceFromBottom: number
}): ScrollAnchorState {
  return {
    isAtBottom: isScrollViewportAtBottom(distanceFromBottom),
    unreadCount: 0,
    shouldScrollToBottom: false,
  }
}

export function reduceScrollAnchorState(
  state: ScrollAnchorState,
  event: ScrollAnchorEvent,
): ScrollAnchorState {
  switch (event.type) {
    case 'viewport-scrolled': {
      const isAtBottom = isScrollViewportAtBottom(event.distanceFromBottom)
      return {
        isAtBottom,
        unreadCount: isAtBottom ? 0 : state.unreadCount,
        shouldScrollToBottom: false,
      }
    }
    case 'content-added':
      if (event.count <= 0) {
        return state
      }
      return state.isAtBottom
        ? { ...state, unreadCount: 0, shouldScrollToBottom: true }
        : {
            ...state,
            unreadCount: state.unreadCount + event.count,
            shouldScrollToBottom: false,
          }
    case 'jump-to-bottom':
      return {
        isAtBottom: true,
        unreadCount: 0,
        shouldScrollToBottom: true,
      }
    case 'scroll-completed':
      return { ...state, shouldScrollToBottom: false }
  }
}
