import type {
  ExtensionMessage,
  ExtensionResponse,
  SiteState
} from "../lib/types";

const siteCopy = document.querySelector<HTMLButtonElement>(".bx-site-toggle-copy");
const siteSwitch = document.querySelector<HTMLButtonElement>(".bx-switch");
const errorMessage = document.querySelector<HTMLElement>(".bx-popup-error");

let state: SiteState = {
  siteEnabled: false,
  siteSupported: true
};
let updating = false;

function sendMessage<T = unknown>(message: ExtensionMessage) {
  return chrome.runtime.sendMessage(message) as Promise<ExtensionResponse<T>>;
}

function render() {
  if (siteCopy) {
    siteCopy.disabled = false;
    siteCopy.setAttribute("aria-busy", String(updating));
  }
  if (siteSwitch) {
    siteSwitch.disabled = false;
    siteSwitch.setAttribute("aria-busy", String(updating));
    siteSwitch.classList.toggle("bx-switch-checked", state.siteEnabled);
    siteSwitch.setAttribute("aria-checked", String(state.siteEnabled));
  }
}

function showError(message: string | null) {
  if (!errorMessage) return;
  errorMessage.textContent = message ?? "";
  errorMessage.hidden = !message;
}

async function toggleSite() {
  if (updating) return;
  updating = true;
  showError(null);
  render();

  try {
    const response = await sendMessage<SiteState>({
      type: "SET_ACTIVE_SITE_ENABLED",
      enabled: !state.siteEnabled,
      includeItems: false
    });
    if (!response.ok || !response.data) {
      showError(response.error ?? "SnapStack cannot be changed on this page.");
      return;
    }
    state = response.data;
  } catch (error) {
    showError(error instanceof Error ? error.message : "SnapStack lost its Chrome connection.");
  } finally {
    updating = false;
    render();
  }
}

siteCopy?.addEventListener("click", () => void toggleSite());
siteSwitch?.addEventListener("click", () => void toggleSite());
render();

void sendMessage<SiteState>({ type: "GET_SITE_STATE" }).then((response) => {
  if (response.ok && response.data) {
    state = response.data;
    render();
  }
}).catch(() => {
  // The static popup remains usable while Chrome restarts the service worker.
});
