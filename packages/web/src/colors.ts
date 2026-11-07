import { useSyncExternalStore } from "react";
import { currentTheme, personColors, THEME_EVENT, type Theme } from "@dendrop/theme";
import type { PublicUser } from "@dendrop/shared";

const subscribe = (cb: () => void) => {
  window.addEventListener(THEME_EVENT, cb);
  return () => window.removeEventListener(THEME_EVENT, cb);
};

/** The active theme, re-rendering when it changes. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, () => currentTheme());
}

/** Inline styles for someone's name and message text in the active theme, adjusted to stay readable. */
export function useColors(): (u: Pick<PublicUser, "nameColor" | "textColor"> | undefined | null) => { name?: { color: string }; text?: { color: string } } {
  const theme = useTheme();
  return (u) => {
    if (!u) return {};
    const c = personColors(theme.tokens, u);
    return { name: c.name ? { color: c.name } : undefined, text: c.text ? { color: c.text } : undefined };
  };
}
