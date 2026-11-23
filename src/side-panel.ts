// Toolbar icon behaviour: open the popup (default) or Chrome's side panel.
// The side panel loads the same page as the popup with an extra `panel`
// flag, so the unlock flow, lock timer and RPC rules are unchanged.
export const POPUP_PATH = "index.html?popup";
export const PANEL_PATH = "index.html?popup&panel";
export type ActionMode = "popup" | "panel";

export const sidePanelSupported = () => !!globalThis.chrome?.sidePanel;

export async function getActionMode(): Promise<ActionMode> {
  const { actionMode } = await chrome.storage.local.get<{
    actionMode?: string;
  }>("actionMode");
  return actionMode === "panel" && sidePanelSupported() ? "panel" : "popup";
}

export async function setActionMode(mode: ActionMode) {
  await chrome.storage.local.set({ actionMode: mode });
}
