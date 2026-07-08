import { useCallback, useEffect, useState } from 'react';
import Admin from './pages/Admin.jsx';
import Debts from './pages/Debts.jsx';
import Finance from './pages/Finance.jsx';
import Master from './pages/Master.jsx';
import { loadCurrentUser, saveTestTelegramId } from './lib/auth.js';
import { supabase } from './lib/supabase.js';

const pages = [
  { id: 'master', title: 'Мастер', component: Master, roles: ['owner', 'master'] },
  { id: 'admin', title: 'Админ', component: Admin, roles: ['owner', 'admin'] },
  { id: 'finance', title: 'Финансы', component: Finance, roles: ['owner', 'finance'] },
  { id: 'debts', title: 'Долги', component: Debts, roles: ['owner', 'finance'] },
];

export default function App() {
  const [currentUser, setCurrentUser] = useState(null);
  const [isLoadingUser, setIsLoadingUser] = useState(true);
  const [authError, setAuthError] = useState('');
  const [testTelegramId, setTestTelegramId] = useState('');
  const [activePageId, setActivePageId] = useState('master');

  const availablePages = currentUser
    ? pages.filter((page) => page.roles.includes(currentUser.role))
    : [];
  const activePage = availablePages.find((page) => page.id === activePageId) || availablePages[0];
  const ActivePage = activePage?.component;

  const refreshCurrentUser = useCallback(async () => {
    setIsLoadingUser(true);
    setAuthError('');

    try {
      const user = await loadCurrentUser();
      setCurrentUser(user);
    } catch (error) {
      setCurrentUser(null);
      setAuthError(error.message || 'Не удалось проверить пользователя.');
    } finally {
      setIsLoadingUser(false);
    }
  }, []);

  useEffect(() => {
    refreshCurrentUser();
  }, [refreshCurrentUser]);

  useEffect(() => {
    if (availablePages.length && !availablePages.some((page) => page.id === activePageId)) {
      setActivePageId(availablePages[0].id);
    }
  }, [activePageId, availablePages]);

  function handleTestLogin(event) {
    event.preventDefault();
    saveTestTelegramId(testTelegramId);
    refreshCurrentUser();
  }

  function handleLogout() {
    localStorage.removeItem('tgAuth');
    setCurrentUser(null);
    setTestTelegramId('');
    setActivePageId('master');
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-mark">M</div>
        <div>
          <h1>это проверка от автора йоууу</h1>
          <p>React + Vite каркас. Бизнес-логика будет перенесена следующими этапами.</p>
        </div>
      </header>

      <section className="status-panel">
        <span>Supabase client</span>
        <strong>{supabase ? 'инициализирован' : 'не настроен'}</strong>
      </section>

      {isLoadingUser ? (
        <section className="status-panel">
          <span>Проверка доступа</span>
          <strong>загрузка...</strong>
        </section>
      ) : currentUser ? (
        <section className="status-panel user-panel">
          <div>
            <span>Пользователь</span>
            <strong>{currentUser.name || 'Без имени'}</strong>
          </div>
          <div>
            <span>Роль</span>
            <strong>{currentUser.role}</strong>
          </div>
          <button className="logout-button" onClick={handleLogout} type="button">
            Выйти
          </button>
        </section>
      ) : (
        <section className="access-card">
          <h2>Нет доступа</h2>
          <p>Введите тестовый telegram_id для локальной проверки пользователя из app_users.</p>
          <form className="login-form" onSubmit={handleTestLogin}>
            <input
              inputMode="numeric"
              onChange={(event) => setTestTelegramId(event.target.value)}
              placeholder="telegram_id"
              type="text"
              value={testTelegramId}
            />
            <button type="submit">Проверить</button>
          </form>
          {authError ? <p className="error-text">{authError}</p> : null}
        </section>
      )}

      {currentUser && ActivePage ? (
        <>
          <nav className="tabs" aria-label="Разделы">
            {availablePages.map((page) => (
              <button
                className={page.id === activePage.id ? 'active' : ''}
                key={page.id}
                onClick={() => setActivePageId(page.id)}
                type="button"
              >
                {page.title}
              </button>
            ))}
          </nav>

          <section className="page-card">
            <ActivePage currentUser={currentUser} />
          </section>
        </>
      ) : null}
    </main>
  );
}
