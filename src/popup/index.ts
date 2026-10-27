import type {
  ExtensionMessage,
  ExtensionResponse,
  SiteState
} from "../lib/types";

const popup = document.querySelector<HTMLElement>(".bx-popup");
const siteCopy = document.querySelector<HTMLButtonElement>(".bx-site-toggle-copy");
const siteSwitch = document.querySelector<HTMLButtonElement>(".bx-site-toggle .bx-switch");
const hostRow = document.querySelector<HTMLElement>(".bx-host-toggle");
const hostCopy = document.querySelector<HTMLButtonElement>(".bx-host-copy");
const hostName = document.querySelector<HTMLElement>(".bx-host-name");
const hostSwitch = document.querySelector<HTMLButtonElement>(".bx-host-switch");
const errorMessage = document.querySelector<HTMLElement>(".bx-popup-error");

let state: SiteState = {
  siteEnabled: false,
  siteSupported: true,
  globalEnabled: false,
  hostname: ""
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
    siteSwitch.classList.toggle("bx-switch-checked", state.globalEnabled);
    siteSwitch.setAttribute("aria-checked", String(state.globalEnabled));
  }

  const showHost = state.globalEnabled && state.siteSupported && Boolean(state.hostname);
  popup?.classList.toggle("bx-popup-has-site", showHost);
  if (hostRow) hostRow.hidden = !showHost;
  if (hostName) {
    hostName.textContent = state.hostname;
    hostName.title = state.hostname;
  }
  if (hostSwitch) {
    hostSwitch.setAttribute("aria-busy", String(updating));
    hostSwitch.classList.toggle("bx-switch-checked", state.siteEnabled);
    hostSwitch.setAttribute("aria-checked", String(state.siteEnabled));
  }
}

function showError(message: string | null) {
  if (!errorMessage) return;
  errorMessage.textContent = message ?? "";
  errorMessage.hidden = !message;
}

async function update(message: ExtensionMessage) {
  if (updating) return;
  updating = true;
  showError(null);
  render();

  try {
    const response = await sendMessage<SiteState>(message);
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

const toggleSite = () => void update({
  type: "SET_ACTIVE_SITE_ENABLED",
  enabled: !state.globalEnabled,
  includeItems: false
});
const toggleHost = () => void update({ type: "SET_SITE_DISABLED", disabled: state.siteEnabled });

siteCopy?.addEventListener("click", toggleSite);
siteSwitch?.addEventListener("click", toggleSite);
hostCopy?.addEventListener("click", toggleHost);
hostSwitch?.addEventListener("click", toggleHost);
render();

void sendMessage<SiteState>({ type: "GET_SITE_STATE" }).then((response) => {
  if (response.ok && response.data) {
    state = response.data;
    render();
  }
}).catch(() => {
  // The static popup remains usable while Chrome restarts the service worker.
});
