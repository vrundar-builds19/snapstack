# SnapStack Privacy Policy

**Effective date:** August 4, 2026

SnapStack is a Chrome extension that lets users capture regions of webpages, save images from webpages into a local image stack, and copy those images for use in applications such as Figma.

## Information SnapStack handles

SnapStack handles only the information needed to provide its screenshot and image-stacking features:

- Screenshot regions that the user explicitly captures.
- Images that the user explicitly saves through the “Save to SnapStack” context-menu action.
- The title, hostname, and URL of the webpage from which an image or screenshot was captured. SnapStack records this source information only when the user deliberately captures or saves an item.
- Extension preferences, including whether SnapStack is enabled, the floater position, and whether onboarding guidance has been dismissed.

Captured webpages may contain personal or sensitive information. SnapStack processes this content only when the user deliberately captures or saves it.

## How information is used

SnapStack uses this information only to:

- Display captured images in the local image stack.
- Preserve the image order and source labels selected by the user.
- Generate a clipboard payload when the user chooses to copy images.
- Restore the user’s extension preferences between browser sessions.

## Local storage and retention

Captured images, thumbnails, source information, and extension preferences are stored locally on the user’s device using `chrome.storage.local`. SnapStack does not use Chrome storage sync. SnapStack currently stores up to 24 images in the stack. When a 25th item is added, the oldest item and its locally stored image data, thumbnail, and source metadata are removed.

SnapStack does not operate a server and does not upload captured images, webpage content, browsing information, or extension preferences to the developer or to third parties.

Items remain stored locally until the user deletes an individual item, selects “Delete all,” removes the extension, clears the extension’s local data through Chrome, or the item is removed by the 24-item limit. Deleting an individual item removes its image data, thumbnail, and source metadata. “Delete all” can be undone for approximately six seconds; after that period, the cleared image data is permanently removed from the extension’s local storage.

## Clipboard access

SnapStack writes image data to the system clipboard only after the user selects a copy action. SnapStack does not read existing clipboard contents. Clipboard contents are created locally and are not transmitted to the developer or to third parties by SnapStack.

Deleting captures, clearing the stack, or removing SnapStack does not clear the system clipboard. Copied data remains on the clipboard until the user or another application replaces it.

## Image requests

When the user selects “Save to SnapStack,” the extension may request the selected image URL directly from the website or content-delivery network hosting that image. The request is made only to retrieve the user-selected image for the local stack. SnapStack does not intentionally attach webpage cookies, account credentials, or authentication information to this cross-origin request. As with a normal network request, the image host may receive technical information such as the user’s IP address and user agent under that host’s own privacy practices.

If the selected image cannot be retrieved directly, SnapStack captures the visible image area from the active tab instead. Captured image data and source metadata are not uploaded to the SnapStack developer.

## Data sharing and sale

SnapStack does not sell, rent, or provide captured images, source metadata, or extension preferences to the developer or to third parties. The direct request to the host of a user-selected image is the only network interaction initiated for image retrieval. SnapStack does not use captured information for advertising, profiling, analytics, creditworthiness, or any purpose unrelated to its user-facing screenshot and image-stacking features.

## Remote code

SnapStack does not download or execute remotely hosted code. All executable code is included in the installed extension package.

## Security

SnapStack limits stored capture data to the user’s local Chrome profile and requests only the browser permissions needed for its features. People or software with access to the user’s device or Chrome profile may be able to access locally stored or copied content. Users should avoid capturing sensitive content if they do not want that content stored in their local Chrome extension data or placed on the system clipboard.

## User choices and deletion

Users can:

- Disable or enable SnapStack.
- Delete individual images from the stack.
- Delete the complete image stack.
- Undo a complete-stack deletion during the available undo period.
- Remove the extension or clear its extension storage through Chrome.

## Changes to this policy

If SnapStack’s data practices change, this policy will be updated before the new practices are introduced. Any material change to how user data is collected, used, or shared will be disclosed as required by the Chrome Web Store policies.

## Contact

For privacy questions or requests, contact:

**Email:** vrundar.builds@gmail.com
