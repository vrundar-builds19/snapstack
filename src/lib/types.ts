export type Annotation =
  | { kind: "box"; x: number; y: number; width: number; height: number; color: string; strokeWidth: number }
  | { kind: "text"; x: number; y: number; text: string; color: string; fontSize: number };

export interface CaptureItem {
  id: string;
  /** What gets copied: the capture with any annotations drawn on it. */
  imageDataUrl: string;
  originalImageDataUrl?: string;
  annotations?: Annotation[];
  thumbnailDataUrl: string;
  width: number;
  height: number;
  sourceTitle: string;
  sourceUrl: string;
  capturedAt: number;
}

export type CapturePreviewItem = Omit<CaptureItem, "imageDataUrl" | "originalImageDataUrl" | "annotations">;

export interface StackState {
  items: CapturePreviewItem[];
  siteEnabled: boolean;
  siteSupported: boolean;
}

export type SiteState = Pick<StackState, "siteEnabled" | "siteSupported">;

export interface CaptureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ContextImageTarget {
  url?: string;
  rect?: CaptureRegion;
  viewportWidth: number;
  viewportHeight: number;
}

export interface PendingScreenshot {
  token: string;
}

export type FloaterEdge = "left" | "right" | "top" | "bottom";

export interface FloaterPosition {
  right: number;
  bottom: number;
  edge?: FloaterEdge;
}

export type ExtensionMessage =
  | { type: "PING" }
  | { type: "GET_STATE" }
  | { type: "GET_SITE_STATE" }
  | { type: "GET_CAPTURE"; id: string }
  | { type: "GET_CAPTURES" }
  | { type: "CAPTURE_VISIBLE" }
  | {
      type: "ADD_CAPTURE";
      screenshotToken: string;
      rect: CaptureRegion;
      viewportWidth: number;
      viewportHeight: number;
      sourceTitle: string;
      sourceUrl: string;
    }
  | { type: "REMOVE_CAPTURE"; id: string }
  | { type: "MOVE_CAPTURE"; id: string; direction: -1 | 1 }
  | {
      type: "UPDATE_CAPTURE_ANNOTATIONS";
      id: string;
      annotations: Annotation[];
      imageDataUrl: string;
      thumbnailDataUrl: string;
    }
  | { type: "CLEAR_STACK" }
  | { type: "RESTORE_CLEARED_STACK"; items: CapturePreviewItem[] }
  | { type: "COMMIT_CLEARED_STACK"; ids: string[] }
  | { type: "SET_ACTIVE_SITE_ENABLED"; enabled: boolean; includeItems?: boolean }
  | { type: "SET_FLOATER_POSITION"; position: FloaterPosition }
  | { type: "OPEN_POPUP" }
  | { type: "START_CAPTURE_ACTIVE" }
  | { type: "GET_CONTEXT_IMAGE_URL" }
  | { type: "SHOW_TOAST"; message: string }
  | { type: "BEGIN_CAPTURE" }
  | { type: "STACK_UPDATED"; items: CapturePreviewItem[] }
  | { type: "SITE_ENABLED_CHANGED"; enabled: boolean }
  | { type: "FLOATER_POSITION_CHANGED"; position: FloaterPosition };

export interface ExtensionResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
