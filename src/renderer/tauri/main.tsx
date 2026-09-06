import { MobileStartup } from './mobile-startup'
import { AppErrorBoundary } from '../error-boundary'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MobileReadingApp } from './mobile-app'
import './mobile.css'

createRoot(document.getElementById('tauri-root')!).render(
  <StrictMode>
    <AppErrorBoundary><MobileStartup><MobileReadingApp /></MobileStartup></AppErrorBoundary>
  </StrictMode>,
)
