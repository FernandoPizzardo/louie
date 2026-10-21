export type Theme = 'system' | 'light' | 'dark'

const THEME_KEY = 'louie.theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

export function getTheme(): Theme {
  const v = localStorage.getItem(THEME_KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}

export function setTheme(theme: Theme): void {
  if (theme === 'system') localStorage.removeItem(THEME_KEY)
  else localStorage.setItem(THEME_KEY, theme)
}

export function resolveDark(theme: Theme): boolean {
  if (theme === 'system') return window.matchMedia(DARK_QUERY).matches
  return theme === 'dark'
}

/** Sets the `.dark` class shadcn keys its colour tokens off. */
export function applyTheme(theme: Theme): void {
  const dark = resolveDark(theme)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}

export const NEXT_THEME: Record<Theme, Theme> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
}
