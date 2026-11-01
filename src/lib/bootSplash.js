// The boot splash in index.html stays until the app has its first figures:
// it used to hand over to App's own splash at the first frame, and two coins
// turning out of step showed the scissors over the «M» on a slow phone (audit
// of 2026-11-01, №49). Now one coin turns for the whole loading.
export function dismissBootSplash() {
  const splash = document.getElementById('boot-splash');
  if (!splash || splash.classList.contains('is-done')) return;
  splash.classList.add('is-done');
  // transitionend does not fire on a hidden page either, so don't make
  // removal depend on it alone.
  splash.addEventListener('transitionend', () => splash.remove(), { once: true });
  setTimeout(() => splash.remove(), 600);
}
