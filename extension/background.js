'use strict';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    for (const [id, title] of [['simplified', '转换为简体'], ['traditional', '转换为繁体']]) {
      // Chrome may classify selected shadow-component text as an ordinary page
      // context. The content script also reads its own preserved selection.
      chrome.contextMenus.create({ id, title, contexts: ['selection', 'page', 'editable', 'link'], documentUrlPatterns: ['http://*/*', 'https://*/*', 'file:///*'] });
    }
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id || !['simplified', 'traditional'].includes(info.menuItemId)) return;
  chrome.tabs.sendMessage(tab.id, {
    type: 'TEXT_SWITCH_CONVERT', direction: info.menuItemId, text: info.selectionText
  }, { frameId: info.frameId ?? 0 }).catch(() => {
    // Restricted pages cannot receive content scripts; the toolbar converter still works.
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`selection-frame:${tabId}`).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === 'TEXT_SWITCH_SELECTION_FRAME' && sender.tab) {
    chrome.storage.session.set({ [`selection-frame:${sender.tab.id}`]: sender.frameId ?? 0 }).catch(() => {});
    return;
  }
  // Selection and replacement requests come only from the extension's own popup.
  if (sender.url !== chrome.runtime.getURL('popup.html') ||
    !['TEXT_SWITCH_GET_ACTIVE_SELECTION', 'TEXT_SWITCH_REPLACE_ACTIVE_SELECTION'].includes(message.type)) return;
  (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { ok: false, error: '请先打开一个网页。' };
    const key = `selection-frame:${tab.id}`;
    const stored = await chrome.storage.session.get(key);
    const frameId = message.frameId ?? stored[key] ?? 0;
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: message.type === 'TEXT_SWITCH_GET_ACTIVE_SELECTION' ? 'TEXT_SWITCH_GET_SELECTION' : 'TEXT_SWITCH_REPLACE',
        text: message.text,
        token: message.token
      }, { frameId });
      return { ...response, frameId };
    } catch {
      return { ok: false, error: '此页面暂时无法读取选区。普通网页请刷新后重试，也可直接粘贴文字转换。' };
    }
  })().then(respond, () => respond({ ok: false, error: '暂时无法连接网页，请刷新后重试。' }));
  return true;
});
