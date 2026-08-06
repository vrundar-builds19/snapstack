# Chrome Web Store Privacy Answers

Use the following text when completing the **Privacy practices** tab in the Chrome Web Store Developer Dashboard.

## Single purpose

SnapStack lets users deliberately capture or save images from webpages into a local visual stack and copy those images without repeatedly switching between Chrome and other applications.

## Permission justifications

### clipboardWrite

Required to place the user-selected image or generated multi-image clipboard payload on the system clipboard after the user chooses a copy action.

### contextMenus

Required to provide the “Save to SnapStack” action when the user right-clicks an image or linked image card.

### scripting

Required to inject or restore SnapStack’s floater and region-selection interface on HTTP and HTTPS webpages after installation, navigation, or a service-worker restart. The injected interface does not capture or save webpage content until the user explicitly chooses a capture or save action.

### storage

Required to store captured images, thumbnails, source labels, stack order, floater position, enabled state, and onboarding preferences locally in the user’s Chrome profile.

### unlimitedStorage

Required because a high-resolution PNG, or a set of up to 24 user-selected captures, can exceed Chrome extension storage’s standard local quota. SnapStack preserves original-quality captures for copying, limits the stack to 24 items, and automatically removes the oldest item when that limit is exceeded.

### Host permission: &lt;all_urls&gt;

Required by Chrome’s `captureVisibleTab()` API for SnapStack’s core region-capture workflow. Users start capture from SnapStack’s persistent webpage floater or the plain `T` shortcut. Chrome does not grant temporary `activeTab` access for those webpage-level interactions, so the API requires the literal `<all_urls>` host permission. SnapStack’s content scripts and user interface remain limited to HTTP and HTTPS webpages, and the extension rejects capture attempts on Chrome internal pages or other unsupported schemes. Host access is also used to retrieve an image only after the user explicitly selects “Save to SnapStack.” SnapStack does not capture or save webpage content during ordinary browsing.

## Remote code

Select:

> No, I am not using remote code.

All executable JavaScript and UI resources are packaged with the extension.

## Data-use disclosures

SnapStack handles the following categories locally on the user’s device:

- **Website content:** screenshot regions and images that the user explicitly captures or saves.
- **Web history or browsing activity:** the source hostname, page title, and URL associated with a saved capture.

Disclose these categories even though SnapStack does not transmit them to the developer or to third parties.

SnapStack:

- Uses this data only for its user-facing screenshot, stacking, labeling, and copying features.
- Does not upload captured content or source metadata to the developer.
- Contacts an image host or content-delivery network only when the user explicitly selects an image to save.
- Does not sell user data.
- Does not use user data for advertising, profiling, lending, or creditworthiness.
- Does not allow the developer to read locally stored captures.
- Stores captures and preferences locally in `chrome.storage.local` and does not use Chrome storage sync.
- Does not read the user’s existing clipboard contents.

## Privacy-policy URL

Publish `PRIVACY_POLICY.md` as a publicly accessible webpage, then enter its HTTPS URL in the Privacy practices tab. Replace the contact placeholder before publishing the page.
