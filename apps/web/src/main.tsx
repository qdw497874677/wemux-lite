import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// 自托管 DM Sans（变量字体，Google Fonts 构建，OFL-1.1），与上游 --font-sans 同一字体，
// 但不依赖运行时访问 fonts.googleapis.com。
import '@fontsource-variable/dm-sans/opsz.css'
import { App } from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
