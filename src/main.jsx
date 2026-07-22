import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import AppErrorFallback from './components/AppErrorFallback.jsx';
import { initSentry, Sentry } from './lib/sentry.js';
import './styles.css';

initSentry();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={<AppErrorFallback />}>
      <App />
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
}
