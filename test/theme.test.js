import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_THEME, nextTheme, normalizeTheme, THEME_KEY, themeTopColor } from '../src/utils/theme.js';

test('everyone has «Стекло» until he picks, and anything unknown is «Стекло»', () => {
  assert.equal(DEFAULT_THEME, 'glass');
  assert.equal(normalizeTheme(null), 'glass');
  assert.equal(normalizeTheme('dark'), 'glass');
  assert.equal(normalizeTheme('evening'), 'evening');
});

test('the button goes from one look to the other and back', () => {
  assert.equal(nextTheme('glass'), 'evening');
  assert.equal(nextTheme('evening'), 'glass');
  assert.equal(nextTheme(undefined), 'evening');
});

test("Telegram's header takes the top edge of the look on screen", () => {
  assert.equal(themeTopColor('glass'), '#D4D2CC');
  assert.equal(themeTopColor('evening'), '#63676F');
  assert.equal(themeTopColor('nonsense'), '#D4D2CC');
});

test('the first frame reads the same key and paints the same colour as the app', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, new RegExp(`localStorage\\.getItem\\('${THEME_KEY}'\\) === 'evening'`));
  assert.match(html, new RegExp(`<meta name="theme-color" content="${themeTopColor('glass')}" />`));
  assert.ok(html.includes(`'${themeTopColor('evening')}'`));
});

test('the button is read in Uzbek too', async () => {
  const { translate } = await import('../src/i18n/index.js');
  assert.equal(translate('Вечерняя тема', 'uz'), 'Kechki mavzu');
  assert.equal(translate('Светлая тема', 'uz'), 'Yorugʻ mavzu');
});
