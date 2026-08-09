import { useCallback, useEffect, useState } from 'react';

/**
 * Panel widths, persisted.
 *
 * A layout you re-adjust on every reload is worse than a fixed one, so the
 * sizes survive in localStorage. Values are clamped on read as well as on
 * write: the defaults change between versions, and a stored 900px code pane
 * from an old wide-window session would otherwise swallow a laptop screen.
 */
const KEY = 'grapheon.panels.v1';

export const LIMITS = {
  side: { min: 180, max: 480, def: 260 },  // file tree / search results
  code: { min: 320, max: 1200, def: 560 }, // code pane
};

const clamp = (k, v) => Math.min(LIMITS[k].max, Math.max(LIMITS[k].min, v));

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return {
      side: clamp('side', Number(raw.side) || LIMITS.side.def),
      code: clamp('code', Number(raw.code) || LIMITS.code.def),
    };
  } catch {
    return { side: LIMITS.side.def, code: LIMITS.code.def };
  }
}

/**
 * Below this the panels are full-screen overlays and there is nothing to
 * resize — and an inline width would BEAT the media query that makes them
 * full-screen, pinning a phone's code pane to whatever a desktop session last
 * dragged it to. Widths are reported as null there so no inline style is set.
 */
const NARROW = '(max-width: 720px)';

export function usePanelWidths() {
  const [widths, setWidths] = useState(load);
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);

  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const on = (e) => setNarrow(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(widths)); } catch { /* private mode */ }
  }, [widths]);

  const set = useCallback((key, value) => {
    setWidths((w) => ({ ...w, [key]: clamp(key, value) }));
  }, []);

  const reset = useCallback((key) => {
    setWidths((w) => ({ ...w, [key]: LIMITS[key].def }));
  }, []);

  return {
    widths: narrow ? { side: null, code: null } : widths,
    raw: widths,
    narrow,
    set,
    reset,
  };
}
