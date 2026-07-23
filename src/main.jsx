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

// Hand the splash over to React. The boot splash in index.html and the
// isLoading splash in App.jsx are drawn identically, so the frames where both
// are on screen look like one continuous animation.
function dismissBootSplash() {
  const splash = document.getElementById('boot-splash');
  if (!splash || splash.classList.contains('is-done')) return;
  splash.classList.add('is-done');
  // transitionend does not fire on a hidden page either, so don't make
  // removal depend on it alone.
  splash.addEventListener('transitionend', () => splash.remove(), { once: true });
  setTimeout(() => splash.remove(), 600);
}

// Fast path: two rAFs — the first is queued before React's commit paints, the
// second after it, so the splash lifts on the frame the app becomes visible.
requestAnimationFrame(() => requestAnimationFrame(dismissBootSplash));

// Fallback: rAF never runs while the page isn't being rendered — Telegram can
// open a Mini App in a backgrounded webview. Without this the splash would sit
// on top of a fully mounted app forever, with no way to dismiss it.
setTimeout(dismissBootSplash, 800);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
}
