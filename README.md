# SnapStack

A Manifest V3 Chrome extension that stays with designers as they browse, captures screenshots or saved images from any site, and lets them copy one image or the full stack into their design tools.

## Features

- Region screenshot capture from ordinary `http` and `https` pages
- Save images from the right-click menu with **Save to SnapStack**
- One persistent image stack shared across tabs
- Floating counter and copy control
- Draggable floater position synchronized across tabs
- **Enable SnapStack** switch in the extension popup
- On/off status in the extension icon tooltip and right-click menu
- Thumbnail preview, full-size image preview, copy, delete, and ordering
- Copy one image or copy the complete stack as SVG-backed independent image layers
- Local-only storage with a 24-capture limit
- `T` capture shortcut on webpages, ignored while typing
- `Option+T` opens the extension popup on macOS
- `Alt+O` shows or hides the floater
- Turn SnapStack off on individual sites from the floater menu, and back on from the popup

## Demo videos

### [ENABLE SNAPSTACK](https://vimeo.com/1215927867?share=copy&fl=sv&fe=ci)

Open SnapStack from the Chrome extension popup or with **Option + T**, then switch it on to bring the floating stack into the browser.

To switch the floater on or off, press **Option + O**.

### [REGION SCREENSHOT CAPTURE](https://vimeo.com/1215934157?share=copy&fl=sv&fe=ci)

Capture only the part of a page you need, switch tabs, and keep adding screenshots to the same floating stack without losing what you captured earlier.

Keyboard shortcut to capture a screenshot: **T**.

### [SAVE IMAGES ACROSS TABS + USE CASE](https://vimeo.com/1215948317?share=copy&fl=sv&fe=ci)

Save images from any webpage with **Right click + Save to SnapStack**, keep them in the same floating stack across tabs, and copy a single image when needed. This demo tests the copied image directly in ChatGPT to show that SnapStack works beyond design tools too.

### [COPY THE FULL STACK INTO FIGMA](https://vimeo.com/1216005522?share=copy&fl=sv&fe=ci)

Collect multiple screenshots and saved images while browsing, then paste the full stack into Figma.

## Build

```bash
npm install
npm run check
```

The loadable extension is generated in `dist/`.

## Install from ZIP

1. Download the release ZIP.
2. Unzip it.
3. Open `chrome://extensions`.
4. Enable **Developer mode**.
5. Choose **Load unpacked**.
6. Select the unzipped extension folder.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the absolute `snapstack/dist` directory.
5. Refresh any tabs that were already open before installation.

## Intended workflow

1. Enable SnapStack from the extension popup.
2. Click **Take Screenshot** or press `T`.
3. Drag over a region of the current page.
4. Switch to any other tab and keep capturing or saving images.
5. Expand the floating stack and click **Copy All Imgs**.
6. Paste once into Figma or FigJam. Figma creates a named container with one independently selectable, source-named image layer per capture.
7. Copy a single image when you want to use it separately in a browser-based tool.

Example handoff names:

- Parent: `SnapStack · 3 refs · 3 Aug`
- Layers: `pinterest-01`, `pinterest-02`, `tumblr-03`

The layered clipboard format is designed for Figma and other apps that understand pasted SVG. Plain text editors may paste the SVG source.

The extension keeps data locally. It does not inject on Chrome internal pages or the Chrome Web Store because Chrome blocks extensions on those pages.
