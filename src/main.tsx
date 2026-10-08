import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import AppErrorBoundary from './components/AppErrorBoundary';
import { MotionConfig } from 'motion/react';
import './index.css';

// Register Service Worker for PWA (production only to prevent dev HMR refresh loops)
if ('serviceWorker' in navigator) {
  if ((import.meta as any).env?.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('PWA service worker registration notice:', err);
      });
    });
  } else {
    // Clear only this app's worker during local dev; leave workers from other
    // applications on the same origin untouched.
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const reg of registrations) {
        if (new URL(reg.active?.scriptURL || reg.installing?.scriptURL || reg.waiting?.scriptURL || '', window.location.href).pathname === '/sw.js') {
          reg.unregister();
        }
      }
    }).catch((err) => console.warn('Could not inspect local service workers:', err));
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <MotionConfig reducedMotion="user">
        <App />
      </MotionConfig>
    </AppErrorBoundary>
  </StrictMode>,
);
