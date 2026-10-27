import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Camera,
  ChevronUp,
  Copy,
  Trash2
} from "lucide-react";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import {
  BUILD_ID,
  CONTENT_HOST_ID,
  FIRST_TIME_GUIDE_DISMISSED_STORAGE_KEY,
  FLOATER_POSITION_STORAGE_KEY,
  MAX_STACK_SIZE
} from "../lib/constants";
import type {
  CaptureItem,
  CapturePreviewItem,
  ContextImageTarget,
  ExtensionMessage,
  ExtensionResponse,
  FloaterPosition,
  PendingScreenshot,
  StackState
} from "../lib/types";

type Point = { x: number; y: number };
type Selection = { start: Point; current: Point };
type DragState = FloaterPosition & {
  pointerId: number;
  startX: number;
  startY: number;
  width: number;
  height: number;
};

let lastContextImageTarget: ContextImageTarget | null = null;

function backgroundImageUrl(element: Element, pseudoElement?: "::before" | "::after") {
  const value = getComputedStyle(element, pseudoElement).backgroundImage;
  const match = value.match(/url\((['"]?)(.*?)\1\)/i);
  if (!match?.[2]) return null;
  try {
    return new URL(match[2], document.baseURI).href;
  } catch {
    return match[2];
  }
}

function hasRenderedBackground(element: Element, pseudoElement?: "::before" | "::after") {
  const value = getComputedStyle(element, pseudoElement).backgroundImage;
  return Boolean(value && value !== "none");
}

function imageTarget(element: Element, url?: string | null): ContextImageTarget {
  const bounds = element.getBoundingClientRect();
  const left = Math.max(0, Math.min(window.innerWidth, bounds.left));
  const top = Math.max(0, Math.min(window.innerHeight, bounds.top));
  const right = Math.max(left, Math.min(window.innerWidth, bounds.right));
  const bottom = Math.max(top, Math.min(window.innerHeight, bounds.bottom));
  const width = right - left;
  const height = bottom - top;

  return {
    ...(url ? { url } : {}),
    ...(width >= 1 && height >= 1
      ? { rect: { x: left, y: top, width, height } }
      : {}),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight
  };
}

function contextImageTarget(event: MouseEvent) {
  const path = event.composedPath().filter((item): item is Element => item instanceof Element);
  for (const element of path) {
    if (element instanceof HTMLImageElement) {
      return imageTarget(element, element.currentSrc || element.src);
    }
    if (element instanceof HTMLVideoElement && element.poster) {
      return imageTarget(element, new URL(element.poster, document.baseURI).href);
    }
    if (element instanceof HTMLCanvasElement || element instanceof SVGSVGElement) {
      return imageTarget(element);
    }
    const background = backgroundImageUrl(element)
      ?? backgroundImageUrl(element, "::before")
      ?? backgroundImageUrl(element, "::after");
    const hasBackground = hasRenderedBackground(element)
      || hasRenderedBackground(element, "::before")
      || hasRenderedBackground(element, "::after");
    if (background || hasBackground) return imageTarget(element, background);

    if (element instanceof HTMLAnchorElement) {
      const images = Array.from(element.querySelectorAll("img"));
      const imageAtPointer = images.find((image) => {
        const rect = image.getBoundingClientRect();
        return event.clientX >= rect.left && event.clientX <= rect.right
          && event.clientY >= rect.top && event.clientY <= rect.bottom;
      });
      const image = imageAtPointer ?? images.find((candidate) => candidate.getClientRects().length > 0);
      if (image) return imageTarget(image, image.currentSrc || image.src);

      const descendants = Array.from(element.querySelectorAll("*")).slice(0, 80);
      for (const descendant of descendants) {
        if (descendant instanceof HTMLVideoElement && descendant.poster) {
          return imageTarget(descendant, new URL(descendant.poster, document.baseURI).href);
        }
        if (descendant instanceof HTMLCanvasElement || descendant instanceof SVGSVGElement) {
          return imageTarget(descendant);
        }
        const descendantBackground = backgroundImageUrl(descendant)
          ?? backgroundImageUrl(descendant, "::before")
          ?? backgroundImageUrl(descendant, "::after");
        const hasDescendantBackground = hasRenderedBackground(descendant)
          || hasRenderedBackground(descendant, "::before")
          || hasRenderedBackground(descendant, "::after");
        if (descendantBackground || hasDescendantBackground) {
          return imageTarget(descendant, descendantBackground);
        }
      }
    }
  }
  return null;
}

window.addEventListener("contextmenu", (event) => {
  lastContextImageTarget = contextImageTarget(event);
}, true);

const FLOATER_DOCK_WIDTH = 275;
const FLOATER_DOCK_HEIGHT = 56;
const DEFAULT_FLOATER_POSITION: FloaterPosition = {
  right: 8,
  bottom: 32,
  edge: "right"
};
const FLOATER_SIDE_GUTTER = 8;
const FLOATER_BOTTOM_GUTTER = 32;
const FLOATER_TOP_GUTTER = 28;
const FLOATER_PANEL_GAP = 10;
const FLOATER_EXTERNAL_GRIP_OFFSET = 30;
const FLOATER_TOAST_GAP = 12;
const FLOATER_TOAST_HEIGHT = 40;
const STACK_PANEL_MAX_HEIGHT = 334;
const DELETE_ALL_UNDO_DURATION_MS = 6000;

function clampFloaterPosition(
  position: FloaterPosition,
  _width = FLOATER_DOCK_WIDTH,
  height = FLOATER_DOCK_HEIGHT
): FloaterPosition {
  return {
    right: FLOATER_SIDE_GUTTER,
    bottom: Math.min(
      Math.max(FLOATER_BOTTOM_GUTTER, position.bottom),
      Math.max(FLOATER_BOTTOM_GUTTER, window.innerHeight - height - FLOATER_TOP_GUTTER)
    ),
    edge: "right"
  };
}

function snapFloaterToNearestEdge(
  position: FloaterPosition,
  width = FLOATER_DOCK_WIDTH,
  height = FLOATER_DOCK_HEIGHT
): FloaterPosition {
  return clampFloaterPosition(position, width, height);
}

function topDockBottom(height = FLOATER_DOCK_HEIGHT) {
  return Math.max(
    FLOATER_BOTTOM_GUTTER,
    window.innerHeight - height - FLOATER_TOP_GUTTER
  );
}

function visualRightInset(right: number) {
  const scrollbarGutter = Math.max(
    0,
    window.innerWidth - document.documentElement.clientWidth
  );
  return Math.max(0, right - scrollbarGutter);
}

async function sendMessage<T = unknown>(message: ExtensionMessage, timeoutMs = 8000) {
  let timeoutId: number | undefined;
  try {
    return await Promise.race([
      chrome.runtime.sendMessage(message) as Promise<ExtensionResponse<T>>,
      new Promise<ExtensionResponse<T>>((resolve) => {
        timeoutId = window.setTimeout(() => resolve({
          ok: false,
          error: "SnapStack took too long. Reload the extension and try again."
        }), timeoutMs);
      })
    ]);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "SnapStack lost its Chrome connection."
    };
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

function selectionRect(selection: Selection) {
  const x = Math.min(selection.start.x, selection.current.x);
  const y = Math.min(selection.start.y, selection.current.y);
  return {
    x,
    y,
    width: Math.abs(selection.current.x - selection.start.x),
    height: Math.abs(selection.current.y - selection.start.y)
  };
}

function escapeSvgAttribute(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sourceLayerSlug(item: CaptureItem) {
  let source = item.sourceTitle || "reference";
  try {
    const hostname = new URL(item.sourceUrl).hostname
      .toLowerCase()
      .replace(/^www\./, "");
    const parts = hostname.split(".").filter(Boolean);
    const hasCompoundCountrySuffix = parts.length > 2
      && parts.at(-1)?.length === 2
      && ["co", "com", "net", "org"].includes(parts.at(-2) ?? "");
    source = parts.at(hasCompoundCountrySuffix ? -3 : -2) ?? parts[0] ?? source;
  } catch {
    // Fall back to the saved page title when the source URL is not parseable.
  }

  return source
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "reference";
}

function snapStackFrameName(itemCount: number) {
  const date = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short"
  }).format(new Date());
  return `SnapStack · ${itemCount} ref${itemCount === 1 ? "" : "s"} · ${date}`;
}

function createLayeredSvg(items: CaptureItem[]) {
  const orderedItems = [...items].sort((a, b) => b.capturedAt - a.capturedAt);
  const gap = 24;
  const width = Math.max(...orderedItems.map((item) => item.width));
  const height = orderedItems.reduce((total, item) => total + item.height, 0)
    + gap * (orderedItems.length - 1);
  const frameName = snapStackFrameName(orderedItems.length);
  const escapedFrameName = escapeSvgAttribute(frameName);
  let offsetY = 0;
  const layers = orderedItems.map((item, index) => {
    const offsetX = Math.round((width - item.width) / 2);
    const layerName = `${sourceLayerSlug(item)}-${String(index + 1).padStart(2, "0")}`;
    const escapedLayerName = escapeSvgAttribute(layerName);
    const layer = `<image id="${escapedLayerName}" data-name="${escapedLayerName}" x="${offsetX}" y="${offsetY}" width="${item.width}" height="${item.height}" href="${item.imageDataUrl}"/>`;
    offsetY += item.height + gap;
    return layer;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" id="${escapedFrameName}" data-name="${escapedFrameName}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>${frameName}</title>${layers.reverse().join("")}</svg>`;
}

function CaptureOverlay({
  onCancel,
  onComplete
}: {
  onCancel: () => void;
  onComplete: (rect: ReturnType<typeof selectionRect>) => void;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const rect = selection ? selectionRect(selection) : null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel]);

  return (
    <div
      className={`bx-selection-overlay${rect ? " bx-selection-overlay--selecting" : ""}`}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        setSelection({
          start: { x: event.clientX, y: event.clientY },
          current: { x: event.clientX, y: event.clientY }
        });
      }}
      onPointerMove={(event) => {
        if (!selection) return;
        setSelection((current) => current && ({
          ...current,
          current: { x: event.clientX, y: event.clientY }
        }));
      }}
      onPointerUp={(event) => {
        if (!selection) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        const nextRect = selectionRect({
          ...selection,
          current: { x: event.clientX, y: event.clientY }
        });
        if (nextRect.width >= 12 && nextRect.height >= 12) onComplete(nextRect);
        else setSelection(null);
      }}
    >
      <div className="bx-selection-hint">
        <span>Drag to capture</span>
        <kbd>esc</kbd>
      </div>
      {rect && (
        <>
          <div
            className="bx-selection-box"
            style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
          />
          <div
            className="bx-selection-size"
            style={{ left: rect.x, top: Math.max(8, rect.y - 30) }}
          >
            {Math.round(rect.width)} × {Math.round(rect.height)}
          </div>
        </>
      )}
    </div>
  );
}

function captureHostname(item: CapturePreviewItem) {
  try {
    return new URL(item.sourceUrl).hostname.replace(/^www\./i, "") || item.sourceTitle;
  } catch {
    return item.sourceTitle || "Unknown source";
  }
}

function CaptureShortcutPrompt() {
  return (
    <span className="bx-capture-shortcut-content">
      <span className="bx-footer-capture-prefix">Press</span>
      <kbd>T</kbd>
      <span className="bx-footer-capture-suffix">to capture screenshot</span>
    </span>
  );
}

function StackPanel({
  items,
  onClose,
  onCapture,
  onRemove,
  onCopy,
  onPreview,
  onClear
}: {
  items: CapturePreviewItem[];
  onClose: () => void;
  onCapture: () => void;
  onRemove: (id: string) => void;
  onCopy: (item: CapturePreviewItem, index: number) => Promise<boolean>;
  onPreview: (item: CapturePreviewItem) => void;
  onClear: () => void;
}) {
  const [copiedItemId, setCopiedItemId] = useState<string | null>(null);
  const [actionTooltip, setActionTooltip] = useState<{
    key: string;
    label: string;
    left: number;
    top: number;
    below: boolean;
  } | null>(null);

  useEffect(() => {
    if (!copiedItemId) return;
    const timeout = window.setTimeout(() => setCopiedItemId(null), 2200);
    return () => window.clearTimeout(timeout);
  }, [copiedItemId]);

  const showActionTooltip = (
    event: React.MouseEvent<HTMLButtonElement> | React.FocusEvent<HTMLButtonElement>,
    key: string,
    label: string
  ) => {
    const buttonRect = event.currentTarget.getBoundingClientRect();
    const shellRect = event.currentTarget.closest(".bx-floating-shell")?.getBoundingClientRect();
    if (!shellRect) return;

    setActionTooltip({
      key,
      label,
      left: buttonRect.left + buttonRect.width / 2 - shellRect.left,
      top: buttonRect.bottom - shellRect.top + 8,
      below: true
    });
  };

  return (
    <>
      <Card className="bx-stack-panel">
      <div className="bx-stack-header">
        <div>
          <div className="bx-stack-eyebrow">IMAGE STACK</div>
          <div className="bx-stack-title">{items.length || "No"} image{items.length === 1 ? "" : "s"}</div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            setActionTooltip(null);
            onClose();
          }}
          onMouseEnter={(event) => showActionTooltip(event, "close-panel", "Minimize")}
          onMouseLeave={() => setActionTooltip(null)}
          onFocus={(event) => showActionTooltip(event, "close-panel", "Minimize")}
          onBlur={() => setActionTooltip(null)}
          aria-label="Minimize image stack"
          aria-describedby={actionTooltip?.key === "close-panel" ? "bx-row-action-tooltip" : undefined}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path d="M12 10V4C12 3.44772 12.4477 3 13 3C13.5523 3 14 3.44772 14 4V10H20C20.5523 10 21 10.4477 21 11C21 11.5523 20.5523 12 20 12H14C12.8955 12 12 11.1045 12 10Z" fill="currentColor" />
            <path d="M10 20V14H4C3.44772 14 3 13.5523 3 13C3.00001 12.4477 3.44773 12 4 12H10C11.1045 12 12 12.8955 12 14V20C12 20.5523 11.5523 21 11 21C10.4477 21 10 20.5523 10 20Z" fill="currentColor" />
          </svg>
        </Button>
      </div>

      {items.length ? (
        <div className="bx-thumbnail-list">
          {items.map((item, index) => (
            <div
              className="bx-thumbnail-row"
              key={item.id}
            >
              <div className="bx-thumbnail-index">{index + 1}</div>
              <button
                type="button"
                className="bx-thumbnail-preview-button"
                onClick={() => {
                  setActionTooltip(null);
                  onPreview(item);
                }}
                aria-label={`Preview screenshot ${index + 1} from ${captureHostname(item)}`}
              >
                <img
                  draggable={false}
                  src={item.thumbnailDataUrl}
                  loading={index < 5 ? "eager" : "lazy"}
                  decoding="async"
                  width={65}
                  height={45}
                  alt=""
                />
              </button>
              <div className="bx-thumbnail-meta">
                <strong>{captureHostname(item)}</strong>
                <span>{item.width} × {item.height}</span>
              </div>
              <div className="bx-row-actions">
                <button
                  onClick={async (event) => {
                    setActionTooltip(null);
                    setCopiedItemId(item.id);
                    showActionTooltip(event, `copy-${item.id}`, "Copied!");
                    if (await onCopy(item, index)) return;
                    setCopiedItemId(null);
                    showActionTooltip(event, `copy-${item.id}`, "Copy");
                  }}
                  onMouseEnter={(event) => showActionTooltip(
                    event,
                    `copy-${item.id}`,
                    copiedItemId === item.id ? "Copied!" : "Copy"
                  )}
                  onMouseLeave={() => setActionTooltip(null)}
                  onFocus={(event) => showActionTooltip(
                    event,
                    `copy-${item.id}`,
                    copiedItemId === item.id ? "Copied!" : "Copy"
                  )}
                  onBlur={() => setActionTooltip(null)}
                  aria-label={copiedItemId === item.id
                    ? `Copied screenshot ${index + 1}`
                    : `Copy screenshot ${index + 1}`}
                  aria-describedby={actionTooltip?.key === `copy-${item.id}` ? "bx-row-action-tooltip" : undefined}
                >
                  {copiedItemId === item.id ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path
                        fillRule="evenodd"
                        clipRule="evenodd"
                        d="M19.6905 5.77665C20.09 6.15799 20.1047 6.79098 19.7234 7.19048L9.22336 18.1905C9.03745 18.3852 8.78086 18.4968 8.51163 18.4999C8.2424 18.5031 7.98328 18.3975 7.79289 18.2071L4.29289 14.7071C3.90237 14.3166 3.90237 13.6834 4.29289 13.2929C4.68342 12.9024 5.31658 12.9024 5.70711 13.2929L8.48336 16.0692L18.2766 5.80953C18.658 5.41003 19.291 5.39531 19.6905 5.77665Z"
                        fill="currentColor"
                      />
                    </svg>
                  ) : (
                    <Copy size={13} />
                  )}
                </button>
                <button
                  onClick={() => {
                    setActionTooltip(null);
                    onRemove(item.id);
                  }}
                  onMouseEnter={(event) => showActionTooltip(event, `delete-${item.id}`, "Delete")}
                  onMouseLeave={() => setActionTooltip(null)}
                  onFocus={(event) => showActionTooltip(event, `delete-${item.id}`, "Delete")}
                  onBlur={() => setActionTooltip(null)}
                  aria-label={`Delete screenshot ${index + 1}`}
                  aria-describedby={actionTooltip?.key === `delete-${item.id}` ? "bx-row-action-tooltip" : undefined}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <button className="bx-empty-state" onClick={onCapture}>
          <span className="bx-empty-icon"><Camera size={18} /></span>
          <strong>Take your first screenshot</strong>
          <span>It will stay here across every tab.</span>
        </button>
      )}

      <div className="bx-stack-footer">
        <div className="bx-footer-actions">
          <div className="bx-footer-capture-shortcut">
            <CaptureShortcutPrompt />
          </div>
          {items.length > 0 && (
            <Button variant="ghost" size="sm" onClick={onClear}>Delete all</Button>
          )}
        </div>
      </div>
      </Card>

      {actionTooltip && (
        <div
          className={`bx-row-action-tooltip${actionTooltip.below ? " bx-row-action-tooltip-below" : ""}`}
          id="bx-row-action-tooltip"
          role="tooltip"
          style={{ left: actionTooltip.left, top: actionTooltip.top }}
        >
          {actionTooltip.label}
        </div>
      )}

    </>
  );
}

function ImagePreviewOverlay({
  item,
  onClose
}: {
  item: CapturePreviewItem;
  onClose: () => void;
}) {
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setImageDataUrl(null);
    setError(null);

    void sendMessage<CaptureItem>({ type: "GET_CAPTURE", id: item.id }, 15000)
      .then((response) => {
        if (cancelled) return;
        if (!response.ok || !response.data?.imageDataUrl) {
          setError(response.error ?? "This image could not be loaded.");
          return;
        }
        setImageDataUrl(response.data.imageDataUrl);
      });

    return () => {
      cancelled = true;
    };
  }, [item.id]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onClose();
    };

    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [onClose]);

  return (
    <div
      className="bx-image-preview-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Preview image from ${captureHostname(item)}`}
      onClick={onClose}
    >
      <div
        className="bx-image-preview-shell"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="bx-image-preview-close"
          onClick={onClose}
          aria-label="Close image preview"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path
              d="M2 2L12 12M12 2L2 12"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <div className="bx-image-preview-frame">
          {imageDataUrl ? (
            <img
              src={imageDataUrl}
              alt={`Preview from ${captureHostname(item)}`}
              draggable={false}
            />
          ) : (
            <div className="bx-image-preview-status">
              {error ?? "Loading preview…"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function App() {
  const [state, setState] = useState<StackState>({
    items: [],
    siteEnabled: false,
    siteSupported: true,
    globalEnabled: false,
    hostname: location.hostname
  });
  const [expanded, setExpanded] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [pendingCaptureCount, setPendingCaptureCount] = useState(0);
  const [copying, setCopying] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [clearedStackUndo, setClearedStackUndo] = useState<CapturePreviewItem[] | null>(null);
  const [previewItem, setPreviewItem] = useState<CapturePreviewItem | null>(null);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [showFirstTimeGuide, setShowFirstTimeGuide] = useState(false);
  const [firstTimeGuideTooltip, setFirstTimeGuideTooltip] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const [floaterPosition, setFloaterPosition] = useState(DEFAULT_FLOATER_POSITION);
  const [draggingFloater, setDraggingFloater] = useState(false);
  const [stackPanelSize, setStackPanelSize] = useState({ width: 0, height: 0 });
  const floatingShellRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const shouldReduceMotion = useReducedMotion();

  const applyStoredFloaterPosition = useCallback((position: FloaterPosition) => {
    if (dragStateRef.current) return;
    const restoredPosition = snapFloaterToNearestEdge(position);
    setFloaterPosition(restoredPosition);
    if (
      position.right !== restoredPosition.right ||
      position.bottom !== restoredPosition.bottom ||
      position.edge !== "right"
    ) {
      void chrome.storage.local.set({
        [FLOATER_POSITION_STORAGE_KEY]: restoredPosition
      });
    }
  }, []);

  const syncFloaterPositionFromStorage = useCallback(() => {
    void chrome.storage.local.get(FLOATER_POSITION_STORAGE_KEY).then((stored) => {
      const position = stored[FLOATER_POSITION_STORAGE_KEY] as FloaterPosition | undefined;
      if (position) applyStoredFloaterPosition(position);
    });
  }, [applyStoredFloaterPosition]);

  useEffect(() => {
    void sendMessage<StackState>({ type: "GET_STATE" }).then((response) => {
      if (response.ok && response.data) setState(response.data);
    });
    syncFloaterPositionFromStorage();
    void chrome.storage.local.get(FIRST_TIME_GUIDE_DISMISSED_STORAGE_KEY).then((stored) => {
      setShowFirstTimeGuide(stored[FIRST_TIME_GUIDE_DISMISSED_STORAGE_KEY] !== true);
    });

    const syncWhenVisible = () => {
      if (document.visibilityState === "visible") syncFloaterPositionFromStorage();
    };
    const syncWhenFocused = () => syncFloaterPositionFromStorage();
    const syncWhenStorageChanges = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (areaName !== "local") return;
      const position = changes[FLOATER_POSITION_STORAGE_KEY]?.newValue as FloaterPosition | undefined;
      if (position) applyStoredFloaterPosition(position);
      const guideDismissed = changes[FIRST_TIME_GUIDE_DISMISSED_STORAGE_KEY]?.newValue;
      if (guideDismissed !== undefined) setShowFirstTimeGuide(guideDismissed !== true);
    };

    document.addEventListener("visibilitychange", syncWhenVisible);
    window.addEventListener("focus", syncWhenFocused);
    chrome.storage.onChanged.addListener(syncWhenStorageChanges);
    return () => {
      document.removeEventListener("visibilitychange", syncWhenVisible);
      window.removeEventListener("focus", syncWhenFocused);
      chrome.storage.onChanged.removeListener(syncWhenStorageChanges);
    };
  }, [applyStoredFloaterPosition, syncFloaterPositionFromStorage]);

  useEffect(() => {
    const onMessage = (
      message: ExtensionMessage,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: ExtensionResponse) => void
    ) => {
      if (message.type === "PING") {
        sendResponse({ ok: true, data: BUILD_ID });
        return;
      }
      if (message.type === "BEGIN_CAPTURE") {
        setExpanded(false);
        setMoreMenuOpen(false);
        setCapturing(true);
        sendResponse({ ok: true });
        return;
      }
      if (message.type === "SHOW_TOAST") {
        setToast(message.message);
        sendResponse({ ok: true });
        return;
      }
      if (message.type === "STACK_UPDATED") {
        setState((current) => ({ ...current, items: message.items }));
        sendResponse({ ok: true });
        return;
      }
      if (message.type === "SITE_ENABLED_CHANGED") {
        setState((current) => ({ ...current, siteEnabled: message.enabled }));
        if (!message.enabled) {
          setExpanded(false);
          setMoreMenuOpen(false);
          setPreviewItem(null);
        }
        sendResponse({ ok: true });
        return;
      }
      if (message.type === "FLOATER_POSITION_CHANGED") {
        applyStoredFloaterPosition(message.position);
        sendResponse({ ok: true });
        return;
      }
      if (message.type === "GET_CONTEXT_IMAGE_URL") {
        sendResponse({
          ok: Boolean(lastContextImageTarget),
          data: lastContextImageTarget ?? undefined
        });
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [applyStoredFloaterPosition]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (!clearedStackUndo) return;
    const timeout = window.setTimeout(() => {
      const ids = clearedStackUndo.map((item) => item.id);
      setClearedStackUndo(null);
      void sendMessage({ type: "COMMIT_CLEARED_STACK", ids });
    }, DELETE_ALL_UNDO_DURATION_MS);
    return () => window.clearTimeout(timeout);
  }, [clearedStackUndo]);

  useEffect(() => {
    if (!state.items.length) setExpanded(false);
  }, [state.items.length]);

  useEffect(() => {
    if (!expanded && !moreMenuOpen) return;

    const collapseOnOutsidePointer = (event: PointerEvent) => {
      if (previewItem) return;
      const shell = floatingShellRef.current;
      if (shell && !event.composedPath().includes(shell)) {
        setExpanded(false);
        setMoreMenuOpen(false);
      }
    };

    const collapseOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setExpanded(false);
      setMoreMenuOpen(false);
    };

    document.addEventListener("pointerdown", collapseOnOutsidePointer, true);
    window.addEventListener("keydown", collapseOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", collapseOnOutsidePointer, true);
      window.removeEventListener("keydown", collapseOnEscape, true);
    };
  }, [expanded, moreMenuOpen, previewItem]);

  useLayoutEffect(() => {
    if (!expanded) {
      setStackPanelSize({ width: 0, height: 0 });
      return;
    }

    const panel = floatingShellRef.current?.querySelector<HTMLElement>(".bx-stack-panel");
    if (!panel) return;

    const measurePanel = () => setStackPanelSize({
      width: panel.offsetWidth,
      height: panel.offsetHeight
    });
    measurePanel();
    const observer = new ResizeObserver(measurePanel);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [expanded, state.items.length]);

  useEffect(() => {
    const keepFloaterInViewport = () => {
      const dock = dockRef.current;
      setFloaterPosition((current) => snapFloaterToNearestEdge(
        current,
        dock?.offsetWidth,
        dock?.offsetHeight
      ));
    };

    window.addEventListener("resize", keepFloaterInViewport);
    return () => window.removeEventListener("resize", keepFloaterInViewport);
  }, []);

  const beginCapture = useCallback(() => {
    setExpanded(false);
    setMoreMenuOpen(false);
    setPreviewItem(null);
    setCapturing(true);
  }, []);

  const dragPositionAt = useCallback((_clientX: number, clientY: number) => {
    const drag = dragStateRef.current;
    if (!drag) return null;
    return clampFloaterPosition({
      right: FLOATER_SIDE_GUTTER,
      bottom: drag.bottom - (clientY - drag.startY),
      edge: "right"
    }, drag.width, drag.height);
  }, []);

  const beginFloaterDrag = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const dock = dockRef.current;
    if (!dock) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      right: floaterPosition.right,
      bottom: floaterPosition.bottom,
      width: dock.offsetWidth,
      height: dock.offsetHeight
    };
    setExpanded(false);
    setMoreMenuOpen(false);
    setPreviewItem(null);
    setDraggingFloater(true);
  }, [floaterPosition]);

  const moveFloater = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (dragStateRef.current?.pointerId !== event.pointerId) return;
    const position = dragPositionAt(event.clientX, event.clientY);
    if (position) setFloaterPosition(position);
  }, [dragPositionAt]);

  const endFloaterDrag = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragStateRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    const position = dragPositionAt(event.clientX, event.clientY);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragStateRef.current = null;
    setDraggingFloater(false);
    if (position) {
      const snappedPosition = snapFloaterToNearestEdge(
        position,
        drag.width,
        drag.height
      );
      setFloaterPosition(snappedPosition);
      void sendMessage({ type: "SET_FLOATER_POSITION", position: snappedPosition });
    }
  }, [dragPositionAt]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      const isQuickOpen =
        event.code === "KeyT" &&
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.repeat;

      if (isQuickOpen) {
        event.preventDefault();
        event.stopPropagation();
        void sendMessage({ type: "OPEN_POPUP" });
        return;
      }

      const target = event.target;
      const isEditing = target instanceof Element && Boolean(
        target.closest("input, textarea, select, [contenteditable]")
      );

      if (
        event.key.toLowerCase() !== "t" ||
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isEditing ||
        !state.siteEnabled ||
        capturing ||
        processing
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      beginCapture();
    };

    window.addEventListener("keydown", onShortcut, true);
    return () => window.removeEventListener("keydown", onShortcut, true);
  }, [beginCapture, capturing, processing, state.siteEnabled]);

  const completeCapture = useCallback(async (rect: ReturnType<typeof selectionRect>) => {
    const host = document.getElementById(CONTENT_HOST_ID);
    const previousVisibility = host?.style.getPropertyValue("visibility") ?? "";
    const previousVisibilityPriority = host?.style.getPropertyPriority("visibility") ?? "";
    let hostRestored = false;
    const restoreHost = () => {
      if (!host || hostRestored) return;
      if (previousVisibility) {
        host.style.setProperty("visibility", previousVisibility, previousVisibilityPriority);
      } else {
        host.style.removeProperty("visibility");
      }
      hostRestored = true;
    };
    let rawCaptureComplete = false;
    let pendingCountAdded = false;

    host?.style.setProperty("visibility", "hidden", "important");
    setCapturing(false);
    setProcessing(true);

    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const screenshot = await sendMessage<PendingScreenshot>({ type: "CAPTURE_VISIBLE" });
      if (!screenshot.ok || !screenshot.data?.token) {
        throw new Error(screenshot.error ?? "Capture failed on this page.");
      }
      restoreHost();
      setPendingCaptureCount((count) => count + 1);
      pendingCountAdded = true;
      rawCaptureComplete = true;
      setProcessing(false);

      const response = await sendMessage<CapturePreviewItem>({
        type: "ADD_CAPTURE",
        screenshotToken: screenshot.data.token,
        rect,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        sourceTitle: document.title,
        sourceUrl: window.location.href
      }, 30_000);
      if (!response.ok) throw new Error(response.error);
      if (response.data) {
        setPendingCaptureCount((count) => Math.max(0, count - 1));
        pendingCountAdded = false;
        setState((current) => ({
          ...current,
          items: current.items.some((item) => item.id === response.data?.id)
            ? current.items
            : [response.data as CapturePreviewItem, ...current.items].slice(0, MAX_STACK_SIZE)
        }));
      }
      setToast("Added to your stack");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Capture failed.");
    } finally {
      restoreHost();
      if (pendingCountAdded) {
        setPendingCaptureCount((count) => Math.max(0, count - 1));
      }
      if (!rawCaptureComplete) setProcessing(false);
    }
  }, []);

  const copyScreenshots = useCallback(async () => {
    if (!state.items.length || copying) return;
    setCopying(true);
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Layer copying is not supported on this page.");
      }
      const response = await sendMessage<CaptureItem[]>({ type: "GET_CAPTURES" }, 30000);
      if (!response.ok || !response.data?.length) {
        throw new Error(response.error ?? "Your image stack is empty.");
      }
      await navigator.clipboard.writeText(createLayeredSvg(response.data));
      setToast(`Copied ${response.data.length} screenshot layer${response.data.length === 1 ? "" : "s"}`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Screenshots could not be copied.");
    } finally {
      setCopying(false);
    }
  }, [copying, state.items]);

  const copyIndividualScreenshot = useCallback(async (item: CapturePreviewItem, index: number) => {
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
        throw new Error("Image copying is not supported on this page.");
      }
      const response = await sendMessage<CaptureItem>({ type: "GET_CAPTURE", id: item.id }, 15000);
      if (!response.ok || !response.data) {
        throw new Error(response.error ?? "This screenshot could not be loaded.");
      }
      const image = await fetch(response.data.imageDataUrl).then((result) => result.blob());
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": image })
      ]);
      return true;
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Screenshot could not be copied.");
      return false;
    }
  }, []);

  const resyncStackAfterMutationError = useCallback(async (message: string) => {
    setToast(message);
    const response = await sendMessage<StackState>({ type: "GET_STATE" });
    if (response.ok && response.data) setState(response.data);
  }, []);

  const removeScreenshot = useCallback((id: string) => {
    setState((current) => ({
      ...current,
      items: current.items.filter((item) => item.id !== id)
    }));
    void sendMessage({ type: "REMOVE_CAPTURE", id }).then((response) => {
      if (!response.ok) {
        void resyncStackAfterMutationError(
          response.error ?? "This screenshot could not be removed."
        );
      }
    });
  }, [resyncStackAfterMutationError]);

  const clearScreenshots = useCallback(() => {
    const clearedItems = state.items;
    if (!clearedItems.length) return;

    if (clearedStackUndo?.length) {
      void sendMessage({
        type: "COMMIT_CLEARED_STACK",
        ids: clearedStackUndo.map((item) => item.id)
      });
    }

    setState((current) => ({ ...current, items: [] }));
    setExpanded(false);
    setClearedStackUndo(clearedItems);
    void sendMessage<CapturePreviewItem[]>({ type: "CLEAR_STACK" }).then((response) => {
      if (!response.ok) {
        setClearedStackUndo(null);
        void resyncStackAfterMutationError(
          response.error ?? "The image stack could not be cleared."
        );
        return;
      }
      if (response.data) {
        setClearedStackUndo((current) => current ? response.data ?? current : null);
      }
    });
  }, [clearedStackUndo, resyncStackAfterMutationError, state.items]);

  const undoClearScreenshots = useCallback(() => {
    const clearedItems = clearedStackUndo;
    if (!clearedItems) return;

    setClearedStackUndo(null);
    setState((current) => {
      const clearedIds = new Set(clearedItems.map((item) => item.id));
      return {
        ...current,
        items: [
          ...clearedItems,
          ...current.items.filter((item) => !clearedIds.has(item.id))
        ]
          .sort((a, b) => b.capturedAt - a.capturedAt)
          .slice(0, MAX_STACK_SIZE)
      };
    });

    void sendMessage<CapturePreviewItem[]>({
      type: "RESTORE_CLEARED_STACK",
      items: clearedItems
    }).then((response) => {
      if (response.ok && response.data) {
        setState((current) => ({
          ...current,
          items: response.data ?? current.items
        }));
        return;
      }
      void resyncStackAfterMutationError(
        response.error ?? "The deleted images could not be restored."
      );
    });
  }, [clearedStackUndo, resyncStackAfterMutationError]);

  const turnOffSnapStack = useCallback(() => {
    setMoreMenuOpen(false);
    setExpanded(false);
    setState((current) => ({ ...current, siteEnabled: false }));
    void sendMessage({
      type: "SET_ACTIVE_SITE_ENABLED",
      enabled: false,
      includeItems: false
    }).then((response) => {
      if (!response.ok) {
        void resyncStackAfterMutationError(
          response.error ?? "SnapStack could not be disabled."
        );
      }
    });
  }, [resyncStackAfterMutationError]);

  const turnOffOnThisSite = useCallback(() => {
    setMoreMenuOpen(false);
    setExpanded(false);
    setState((current) => ({ ...current, siteEnabled: false }));
    void sendMessage({ type: "SET_SITE_DISABLED", disabled: true }).then((response) => {
      if (!response.ok) {
        void resyncStackAfterMutationError(
          response.error ?? "SnapStack could not be turned off on this site."
        );
      }
    });
  }, [resyncStackAfterMutationError]);

  const visibleItemCount = Math.min(MAX_STACK_SIZE, state.items.length + pendingCaptureCount);
  const stackLabel = useMemo(
    () => `${visibleItemCount} image${visibleItemCount === 1 ? "" : "s"} in the stack`,
    [visibleItemCount]
  );
  const dockWidth = dockRef.current?.offsetWidth ?? FLOATER_DOCK_WIDTH;
  const dockHeight = dockRef.current?.offsetHeight ?? FLOATER_DOCK_HEIGHT;
  const dockLeft = window.innerWidth - floaterPosition.right - dockWidth;
  const dockTop = window.innerHeight - floaterPosition.bottom - dockHeight;
  const dockedAtTop = floaterPosition.bottom >= topDockBottom(dockHeight) - 1;
  const panelWouldCrossTopGutter = expanded && (
    dockTop - FLOATER_PANEL_GAP - STACK_PANEL_MAX_HEIGHT < FLOATER_TOP_GUTTER
  );
  const panelWouldCrossLeftGutter = expanded && stackPanelSize.width > 0 && (
    dockLeft + dockWidth - FLOATER_EXTERNAL_GRIP_OFFSET - stackPanelSize.width
      < FLOATER_SIDE_GUTTER
  );
  const opensBelow = !draggingFloater && (dockedAtTop || panelWouldCrossTopGutter);
  const opensRight = !draggingFloater && panelWouldCrossLeftGutter;
  const floatingShellStyle: React.CSSProperties = {
    ...(opensRight
      ? { left: dockLeft, right: "auto" }
      : { left: "auto", right: visualRightInset(floaterPosition.right) }),
        ...(opensBelow
      ? { top: dockedAtTop ? FLOATER_TOP_GUTTER : dockTop, bottom: "auto" }
      : {
          top: "auto",
          bottom: floaterPosition.bottom
        })
  };

  const dismissFirstTimeGuide = useCallback(() => {
    setFirstTimeGuideTooltip(null);
    setShowFirstTimeGuide(false);

    void chrome.storage.local.set({
      [FIRST_TIME_GUIDE_DISMISSED_STORAGE_KEY]: true
    });
  }, []);

  if (!state.siteEnabled) return null;

  return (
    <>
      {capturing && (
        <CaptureOverlay onCancel={() => setCapturing(false)} onComplete={completeCapture} />
      )}

      {!capturing && (
        <div
          className={`bx-floating-shell${draggingFloater ? " bx-floating-shell-dragging" : ""}${opensBelow ? " bx-floating-shell-open-below" : ""}${opensRight ? " bx-floating-shell-docked-left" : ""}${showFirstTimeGuide ? " bx-floating-shell-has-guide" : ""}`}
          ref={floatingShellRef}
          style={floatingShellStyle}
        >
          {expanded && !draggingFloater && (
            <StackPanel
              items={state.items}
              onClose={() => setExpanded(false)}
              onCapture={beginCapture}
              onRemove={removeScreenshot}
              onCopy={copyIndividualScreenshot}
              onPreview={setPreviewItem}
              onClear={clearScreenshots}
            />
          )}

          <div
            className="bx-dock"
            aria-label="SnapStack controls"
            ref={dockRef}
          >
            <div className="bx-dock-main">
              <div
                className={`bx-dock-count${visibleItemCount ? "" : " bx-dock-count-empty"}`}
                aria-label={stackLabel}
              >
                {visibleItemCount}
              </div>
              <button
                className={`bx-stack-toggle${expanded ? " bx-stack-toggle-active" : ""}`}
                onClick={() => {
                  setMoreMenuOpen(false);
                  setExpanded((value) => !value);
                }}
                disabled={!state.items.length}
                aria-label={expanded ? "Close image stack" : "Open image stack"}
                aria-expanded={expanded}
              >
                <ChevronUp size={16} strokeWidth={2.25} />
              </button>
              <button
                className="bx-copy-images"
                onClick={() => void copyScreenshots()}
                disabled={!state.items.length || copying}
                aria-label="Copy all images"
              >
                <img
                  className="bx-copy-images-icon"
                  src={chrome.runtime.getURL(
                    state.items.length ? "copy-images-active.svg" : "copy-images-disabled.svg"
                  )}
                  alt=""
                />
                <span>{copying ? "Copying…" : "Copy All Imgs"}</span>
              </button>
              <button
                type="button"
                className={`bx-dock-more${moreMenuOpen ? " bx-dock-more-active" : ""}`}
                onClick={() => {
                  setExpanded(false);
                  setMoreMenuOpen((value) => !value);
                }}
                aria-label="More SnapStack options"
                aria-expanded={moreMenuOpen}
                aria-haspopup="menu"
                aria-controls="bx-snapstack-more-menu"
              >
                <svg
                  width="20"
                  height="36"
                  viewBox="0 0 20 36"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M9.99996 18.0026V17.586M9.99996 12.1693V11.7526M9.99996 23.836V23.4193M10.8333 18.0026C10.8333 17.5424 10.4602 17.1693 9.99996 17.1693C9.53971 17.1693 9.16663 17.5424 9.16663 18.0026C9.16663 18.4628 9.53971 18.836 9.99996 18.836C10.4602 18.836 10.8333 18.4628 10.8333 18.0026ZM10.8333 12.1693C10.8333 11.709 10.4602 11.3359 9.99996 11.3359C9.53971 11.3359 9.16663 11.709 9.16663 12.1693C9.16663 12.6295 9.53971 13.0026 9.99996 13.0026C10.4602 13.0026 10.8333 12.6295 10.8333 12.1693ZM10.8333 23.836C10.8333 23.3757 10.4602 23.0026 9.99996 23.0026C9.53971 23.0026 9.16663 23.3757 9.16663 23.836C9.16663 24.2961 9.53971 24.6693 9.99996 24.6693C10.4602 24.6693 10.8333 24.2961 10.8333 23.836Z"
                    stroke="currentColor"
                    strokeWidth="1.25"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>

              {moreMenuOpen && !draggingFloater && (
                <div
                  className="bx-more-menu bx-more-menu-below"
                  id="bx-snapstack-more-menu"
                  role="menu"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={turnOffOnThisSite}
                    title={`Turn off on ${location.hostname}`}
                  >
                    <span>Turn off on {location.hostname}</span>
                  </button>
                  <button type="button" role="menuitem" onClick={turnOffSnapStack}>
                    Turn off SnapStack
                  </button>
                </div>
              )}
            </div>

            <button
              className={`bx-drag-handle${draggingFloater ? " bx-drag-handle-active" : ""}`}
              onPointerDown={beginFloaterDrag}
              onPointerMove={moveFloater}
              onPointerUp={endFloaterDrag}
              onPointerCancel={endFloaterDrag}
              aria-label="Drag SnapStack floater"
              title="Drag floater"
            >
              <img src={chrome.runtime.getURL("drag-handle.svg")} alt="" draggable={false} />
            </button>
          </div>

          {showFirstTimeGuide && (
            <div className="bx-first-time-guide" role="note">
              <div className="bx-first-time-guide-prompt">
                <span className="bx-first-time-guide-prefix">Press</span>
                <kbd>T</kbd>
                <span className="bx-first-time-guide-suffix">To Capture Screenshot</span>
              </div>
              <button
                type="button"
                className="bx-first-time-guide-close"
                onClick={dismissFirstTimeGuide}
                onMouseEnter={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setFirstTimeGuideTooltip({
                    left: rect.left + rect.width / 2,
                    top: Math.min(rect.bottom + 12, window.innerHeight - 42)
                  });
                }}
                onMouseLeave={() => setFirstTimeGuideTooltip(null)}
                onFocus={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setFirstTimeGuideTooltip({
                    left: rect.left + rect.width / 2,
                    top: Math.min(rect.bottom + 12, window.innerHeight - 42)
                  });
                }}
                onBlur={() => setFirstTimeGuideTooltip(null)}
                aria-label="Dismiss screenshot shortcut tip"
              >
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
                  <path
                    d="M1 1L7 7M7 1L1 7"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          )}

        </div>
      )}

      {previewItem && !capturing && (
        <ImagePreviewOverlay
          item={previewItem}
          onClose={() => setPreviewItem(null)}
        />
      )}

      {firstTimeGuideTooltip && showFirstTimeGuide && (
        <div
          className="bx-first-time-guide-tooltip"
          role="tooltip"
          style={firstTimeGuideTooltip}
        >
          Close
        </div>
      )}

      <AnimatePresence>
        {toast && (
          <motion.div
            className="bx-toast"
            role="status"
            initial={{
              opacity: shouldReduceMotion ? 1 : 0,
              x: "-50%",
              y: shouldReduceMotion ? 0 : 18,
              scale: shouldReduceMotion ? 1 : 0.98
            }}
            animate={{
              opacity: 1,
              x: "-50%",
              y: 0,
              scale: 1
            }}
            exit={{
              opacity: 0,
              x: "-50%",
              y: shouldReduceMotion ? 0 : 18,
              scale: shouldReduceMotion ? 1 : 0.98
            }}
            transition={{
              duration: shouldReduceMotion ? 0 : 0.26,
              ease: [0.22, 1, 0.36, 1]
            }}
          >
            {(toast === "Added to your stack" || toast.startsWith("Copied") || toast.startsWith("Saved")) && (
              <img
                className="bx-toast-success-icon"
                src={chrome.runtime.getURL("toast-success.svg")}
                alt=""
              />
            )}
            <span>{toast}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {clearedStackUndo && !capturing && (
        <div
          className="bx-undo-toast"
          role="status"
          style={{
            right: visualRightInset(
              floaterPosition.right + FLOATER_EXTERNAL_GRIP_OFFSET
            ),
            top: dockTop - FLOATER_TOAST_GAP - FLOATER_TOAST_HEIGHT
          }}
        >
          <span>Deleted All</span>
          <button
            type="button"
            onClick={undoClearScreenshots}
            aria-label="Undo delete all"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M2 5.33398H10C12.2091 5.33398 14 7.12485 14 9.33398C14 11.5431 12.2091 13.334 10 13.334H7.33333"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M4.66667 7.99935L2 5.33268L4.66667 2.66602"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>Undo</span>
          </button>
          <span className="bx-undo-toast-progress" aria-hidden="true" />
        </div>
      )}
    </>
  );
}

if (!document.getElementById(CONTENT_HOST_ID)) {
  const host = document.createElement("div");
  host.id = CONTENT_HOST_ID;
  host.style.setProperty("position", "fixed", "important");
  host.style.setProperty("inset", "0", "important");
  host.style.setProperty("z-index", "2147483647", "important");
  host.style.setProperty("pointer-events", "none", "important");
  const shadow = host.attachShadow({ mode: "open" });
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  const stylesheetUrl = new URL(chrome.runtime.getURL("styles.css"));
  stylesheetUrl.searchParams.set("build", BUILD_ID);
  stylesheet.href = stylesheetUrl.href;
  const root = document.createElement("div");
  root.className = "snapstack-shadow-root";
  let mounted = false;
  let mounting = false;
  const mountApp = async () => {
    if (mounted || mounting || !root.isConnected) return;
    mounting = true;
    try {
      await Promise.all([400, 500, 600, 700].map((weight) => (
        document.fonts.load(`${weight} 14px "SnapStack Inter"`)
      )));
    } catch {
      // The bundled stylesheet still provides the same private font-family fallback.
    }
    if (!root.isConnected) return;
    mounted = true;
    createRoot(root).render(<App />);
  };
  stylesheet.addEventListener("load", () => void mountApp(), { once: true });
  stylesheet.addEventListener("error", () => void mountApp(), { once: true });
  shadow.append(stylesheet, root);
  document.documentElement.appendChild(host);
}
