import { useCallback, useRef } from 'react';

/**
 * Drag handle between two panels.
 *
 * Pointer events rather than mouse events, so a stylus or a tablet finger
 * works with no extra code — and `setPointerCapture` keeps the drag alive when
 * the cursor outruns the 5px handle, which is most of the time.
 *
 * @param {'left'|'right'} side  which neighbour this handle resizes: 'left'
 *   grows as you drag right (a panel before the divider), 'right' is the
 *   mirror (a panel after it, like the code pane).
 */
export default function Divider({ side, width, min, max, onResize, onReset, label }) {
  const start = useRef(null);

  const onPointerDown = useCallback((e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, width };
    document.body.classList.add('resizing');
  }, [width]);

  const onPointerMove = useCallback((e) => {
    if (!start.current) return;
    const delta = e.clientX - start.current.x;
    const raw = side === 'left' ? start.current.width + delta : start.current.width - delta;
    onResize(Math.round(Math.min(max, Math.max(min, raw))));
  }, [side, min, max, onResize]);

  const end = useCallback((e) => {
    if (!start.current) return;
    start.current = null;
    document.body.classList.remove('resizing');
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }, []);

  return (
    <div
      className="divider"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      title={`${label} — drag to resize, double-click to reset`}
    />
  );
}
