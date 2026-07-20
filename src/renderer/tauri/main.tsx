import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MobileReadingApp } from './mobile-app'
import './mobile.css'

createRoot(document.getElementById('tauri-root')!).render(
  <StrictMode>
    <MobileReadingApp />
  </StrictMode>,
)
