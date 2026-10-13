(() => {
  'use strict';
  const source = document.querySelector('#source');
  const result = document.querySelector('#result');
  const copy = document.querySelector('#copy');
  const replace = document.querySelector('#replace');
  const feedback = document.querySelector('#status');
  const floating = document.querySelector('#floating');
  const variant = document.querySelector('#variant');
  let direction = 'traditional';
  let selection = null;
  let reading = false;
  let editRevision = 0;

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
    await readSelection(true);
  })();
})();
