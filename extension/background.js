'use strict';
async function setup() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}
setup().catch(() => {});
chrome.runtime.onInstalled.addListener(() => { setup().catch(() => {}); });
const boundPorts = new Map();
const stopTimers = new Map();
function removeBinding(tabId, port) {
  const ports = boundPorts.get(tabId);
  if (!ports) return;
  ports.delete(port);
  if (!ports.size) boundPorts.delete(tabId);
}
function stopAfterDisconnect(tabId) {
  if (boundPorts.has(tabId) || stopTimers.has(tabId)) return;
  const timer = setTimeout(() => {
    stopTimers.delete(tabId);
    if (!boundPorts.has(tabId)) chrome.tabs.sendMessage(tabId, { type: 'QH_STOP' }).catch(() => {});
  }, 1500);
  stopTimers.set(tabId, timer);
}
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'QH_PANEL' || port.sender?.tab) return;
  let tabId = null;
  port.onMessage.addListener(message => {
    if (message.type === 'BIND' && Number.isInteger(message.tabId)) {
      if (tabId !== null) removeBinding(tabId, port);
      tabId = message.tabId;
      if (!boundPorts.has(tabId)) boundPorts.set(tabId, new Set());
      boundPorts.get(tabId).add(port);
      clearTimeout(stopTimers.get(tabId));
      stopTimers.delete(tabId);
    }
    if (message.type === 'UNBIND' && tabId !== null) {
      removeBinding(tabId, port);
      tabId = null;
    }
  });
  port.onDisconnect.addListener(() => {
    if (tabId !== null) {
      removeBinding(tabId, port);
      stopAfterDisconnect(tabId);
    }
  });
});
