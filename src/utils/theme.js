// Two looks, and each person picks one with the button in the header (owner's
// decision of 2026-10-29): «Стекло», frosted and light, which everyone has
// until he chooses, and «Вечер», smoked glass over the salon at dusk. The
// choice stays on the phone, like the language before the server answers.
export const THEME_KEY = 'maestroTheme';
export const THEMES = ['glass', 'evening'];
export const DEFAULT_THEME = 'glass';

// The top edge of each look as drawn: Telegram's header, theme-color and the
// page ground take it, so no strip of the other colour shows above the page.
const TOP_COLORS = { glass: '#D4D2CC', evening: '#63676F' };

export function normalizeTheme(value) {
  return THEMES.includes(value) ? value : DEFAULT_THEME;
}

export function nextTheme(theme) {
  return normalizeTheme(theme) === 'evening' ? 'glass' : 'evening';
}

export function themeTopColor(theme) {
  return TOP_COLORS[normalizeTheme(theme)];
}
