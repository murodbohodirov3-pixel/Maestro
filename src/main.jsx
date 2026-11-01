import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import AppErrorFallback from './components/AppErrorFallback.jsx';
import { dismissBootSplash } from './lib/bootSplash.js';
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

// The splash lifts when the app has loaded (App, dismissBootSplash). Should
// the app never get there, it lifts anyway, onto App's own splash or error.
setTimeout(dismissBootSplash, 10000);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
}
