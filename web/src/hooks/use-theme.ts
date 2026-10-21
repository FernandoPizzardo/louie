import { useCallback, useEffect, useState } from 'react'
import { applyTheme, getTheme, NEXT_THEME, setTheme, type Theme } from '@/lib/theme'

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getTheme)

  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'system') return
    // Follow the OS while in "system" mode.
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

  const cycle = useCallback(() => {
    setThemeState((t) => {
      const next = NEXT_THEME[t]
      setTheme(next)
      return next
    })
  }, [])

  return { theme, cycle }
}
