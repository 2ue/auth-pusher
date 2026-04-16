import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App'
import { FeedbackProvider } from './components/FeedbackProvider'
import { Toaster } from '@/components/ui/sonner'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FeedbackProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
      <Toaster />
    </FeedbackProvider>
  </StrictMode>,
)
