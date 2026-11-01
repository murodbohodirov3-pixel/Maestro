import { useEffect } from 'react';
import { dismissBootSplash } from '../lib/bootSplash.js';

export default function AppErrorFallback() {
  useEffect(() => {
    dismissBootSplash();
  }, []);
  return (
    <main className="loading-splash" role="alert">
      <div>
        <h1>Maestro</h1>
        <p>Произошла ошибка. Обновите страницу и попробуйте ещё раз.</p>
      </div>
    </main>
  );
}

