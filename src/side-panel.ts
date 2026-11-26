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

/**
 * Puts Chrome's toolbar icon in line with the saved mode: in panel mode the
 * global popup is cleared (a popup always wins over the side panel) and the
 * icon toggles the panel; incognito tabs keep a tab-level popup. Chrome keeps
 * the popup and the panel behaviour in two separate places, so this runs on
 * every start and whenever the popup notices they disagree.
 */
export async function applyActionMode() {
  if (!sidePanelSupported()) return;
  const panel = (await getActionMode()) === "panel";
  await chrome.action.setPopup({ popup: panel ? "" : POPUP_PATH });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: panel });
  for (const tab of await chrome.tabs.query({ windowType: "normal" }))
    if (tab.incognito && tab.id !== undefined) privatePopup(tab.id);
}
export function privatePopup(tabId: number) {
  void chrome.action.setPopup({ tabId, popup: POPUP_PATH }).catch(() => {});
}
