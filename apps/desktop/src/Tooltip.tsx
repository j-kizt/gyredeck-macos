import { cloneElement, isValidElement, useCallback, useState, type FocusEvent as ReactFocusEvent, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";
import { createPortal } from "react-dom";

interface ITriggerProps {
  onMouseEnter?: (event: ReactMouseEvent<HTMLElement>) => void;
  onMouseLeave?: (event: ReactMouseEvent<HTMLElement>) => void;
  onFocus?: (event: ReactFocusEvent<HTMLElement>) => void;
  onBlur?: (event: ReactFocusEvent<HTMLElement>) => void;
}

interface ITooltipProps {
  label: string | null | undefined;
  children: ReactElement<ITriggerProps>;
}

const EDGE_MARGIN = 8;

// A hover/focus tooltip that only appears when its trigger's text is actually
// clipped (single-line ellipsis or clamped). It clones the child to attach
// handlers — no wrapper element — and renders the bubble in a body portal so
// scroll containers can't clip it.
export const Tooltip = ({ label, children }: ITooltipProps) => {
  const [box, setBox] = useState<{ x: number; y: number; below: boolean } | null>(null);

  const show = useCallback((element: HTMLElement) => {
    if (!label) return;
    const clipped = element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1;
    if (!clipped) return;
    const rect = element.getBoundingClientRect();
    const below = rect.top < 44;
    const x = Math.min(Math.max(rect.left + rect.width / 2, EDGE_MARGIN), window.innerWidth - EDGE_MARGIN);
    setBox({ x, y: below ? rect.bottom : rect.top, below });
  }, [label]);

  const hide = useCallback(() => setBox(null), []);

  if (!isValidElement(children) || !label) return children ?? null;

  const trigger = cloneElement(children, {
    onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => {
      children.props.onMouseEnter?.(event);
      show(event.currentTarget);
    },
    onMouseLeave: (event: ReactMouseEvent<HTMLElement>) => {
      children.props.onMouseLeave?.(event);
      hide();
    },
    onFocus: (event: ReactFocusEvent<HTMLElement>) => {
      children.props.onFocus?.(event);
      show(event.currentTarget);
    },
    onBlur: (event: ReactFocusEvent<HTMLElement>) => {
      children.props.onBlur?.(event);
      hide();
    },
  });

  return (
    <>
      {trigger}
      {box
        ? createPortal(
            <div className="app-tooltip" role="tooltip" data-below={box.below} style={{ left: box.x, top: box.y }}>
              {label}
            </div>,
            document.body,
          )
        : null}
    </>
  );
};
