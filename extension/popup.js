(() => {
  'use strict';
  const source = document.querySelector('#source');
  const result = document.querySelector('#result');
  const copy = document.querySelector('#copy');
  const replace = document.querySelector('#replace');
  const feedback = document.querySelector('#status');
  const floating = document.querySelector('#floating');
  const variant = document.querySelector('#variant');
  const bulkFeedback = document.querySelector('#bulk-status');
  const bulkUndo = document.querySelector('#bulk-undo');
  const bulkButtons = [...document.querySelectorAll('[data-bulk-direction]')];
  let direction = 'traditional';
  let selection = null;
  let reading = false;
  let editRevision = 0;
  let bulkBusy = false;

  function bulkStatus(text, kind = '') {
    bulkFeedback.textContent = text;
    bulkFeedback.dataset.error = String(kind === 'error');
    bulkFeedback.dataset.success = String(kind === 'success');
  }

  async function batch(nextDirection, undo = false) {
    if (bulkBusy) return;
    bulkBusy = true;
    editRevision++;
    selection = null;
    replace.hidden = true;
    for (const button of bulkButtons) button.disabled = true;
    bulkUndo.disabled = true;
    bulkStatus(undo ? '正在撤销…' : '正在转换页面输入框…');
    try {
      const response = await chrome.runtime.sendMessage({
        type: undo ? 'TEXT_SWITCH_BULK_UNDO' : 'TEXT_SWITCH_BULK_CONVERT', direction: nextDirection, variant: variant.value
      });
      if (!response?.ok) { bulkStatus(response?.error || '无法连接网页，请刷新后重试。', 'error'); return; }
      bulkUndo.hidden = !response.undoAvailable;
      const action = undo ? '已撤销' : '已转换';
      let text = response.changed ? `${action} ${response.changed} 个输入框。` : undo ? '没有可撤销的输入框。' : '没有需要转换的可见输入框。';
      if (response.skipped) text += ` ${response.skipped} 个因内容变化或页面限制已跳过。`;
      if (response.inaccessibleFrames) text += ` ${response.inaccessibleFrames} 个内嵌页面因访问限制未处理。`;
      bulkStatus(text, response.changed ? 'success' : '');
    } catch { bulkStatus('无法连接网页，请刷新后重试。', 'error'); }
    finally {
      bulkBusy = false;
      for (const button of bulkButtons) button.disabled = false;
      bulkUndo.disabled = false;
    }
  }

  for (const button of bulkButtons) button.addEventListener('click', () => batch(button.dataset.bulkDirection));
  bulkUndo.addEventListener('click', () => batch(null, true));

  function status(text, kind = '') {
    feedback.textContent = text;
    feedback.dataset.error = String(kind === 'error');
    feedback.dataset.success = String(kind === 'success');
  }

  function convert() {
    result.value = TextSwitch.convert(source.value, direction, variant.value);
    document.querySelector('#count').textContent = `${Array.from(result.value).length} 字`;
    document.querySelector('#result-label').textContent = direction === 'simplified' ? '简体结果' : '繁体结果';
    copy.disabled = !result.value;
    replace.hidden = !selection?.editable;
    replace.disabled = !result.value;
  }

  async function readSelection(automatic = false) {
    if (reading) return;
    reading = true;
    const revision = editRevision;
    document.querySelector('#read-selection').disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'TEXT_SWITCH_GET_ACTIVE_SELECTION' });
      // Never let a slow page response overwrite text the user has started typing.
      if (revision !== editRevision) return;
      if (response?.ok) {
        selection = response;
        source.value = response.text;
        convert();
        status(response.editable ? '来自输入框选区 · 可直接替换选中的部分' : '已读取网页选区 · 转换后可复制');
      } else {
        selection = null;
        convert();
        if (!automatic) status(response?.error || '没有找到中文选区，请先选中文字。');
      }
    } catch {
      if (!automatic) status('暂时无法读取网页选区，可粘贴文字后转换。', 'error');
    } finally {
      reading = false;
      document.querySelector('#read-selection').disabled = false;
    }
  }

  source.addEventListener('input', () => {
    editRevision++;
    selection = null;
    convert();
    status('所有转换都在本机完成。');
  });
  document.querySelectorAll('[data-direction]').forEach((button) => {
    button.addEventListener('click', () => {
      direction = button.dataset.direction;
      document.querySelectorAll('[data-direction]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
      convert();
    });
  });
  document.querySelector('#read-selection').addEventListener('click', () => readSelection());
  copy.addEventListener('click', async () => {
    try { await TextSwitch.copy(result.value); status('已复制到剪贴板', 'success'); }
    catch (error) { status(error.message, 'error'); }
  });
  replace.addEventListener('click', async () => {
    if (!selection?.editable) return;
    replace.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'TEXT_SWITCH_REPLACE_ACTIVE_SELECTION', frameId: selection.frameId, token: selection.token, text: result.value
      });
      if (response?.ok) {
        selection = null;
        replace.hidden = true;
        status('已替换输入框中选中的文字', 'success');
      } else status(response?.error || '替换失败，请重新选中文字。', 'error');
    } catch { status('无法连接原输入框，请重新选中文字。', 'error'); }
    finally { replace.disabled = false; }
  });
  async function save() {
    try {
      await chrome.storage.local.set({ floatingEnabled: floating.checked, traditionalVariant: variant.value });
      convert();
      status('偏好已保存', 'success');
    } catch { status('偏好保存失败，请重试。', 'error'); }
  }
  floating.addEventListener('change', save);
  variant.addEventListener('change', save);
  (async () => {
    try {
      const value = TextSwitch.settings(await chrome.storage.local.get(TextSwitch.defaults));
      floating.checked = value.floatingEnabled;
      variant.value = value.traditionalVariant;
    } catch { /* defaults still permit offline conversion */ }
    convert();
    const stateRevision = editRevision;
    chrome.runtime.sendMessage({ type: 'TEXT_SWITCH_BULK_STATE' }).then(response => {
      if (!bulkBusy && stateRevision === editRevision && response?.ok) bulkUndo.hidden = !response.undoAvailable;
    }).catch(() => {});
    await readSelection(true);
  })();
})();
