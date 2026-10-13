(() => {
  'use strict';
  const converters = new Map();
  const defaults = Object.freeze({ floatingEnabled: true, traditionalVariant: 't' });
  const variants = new Set(['t', 'tw', 'hk']);

  function settings(value = {}) {
    return {
      floatingEnabled: typeof value.floatingEnabled === 'boolean' ? value.floatingEnabled : true,
      traditionalVariant: variants.has(value.traditionalVariant) ? value.traditionalVariant : 't'
    };
  }

  function convert(text, direction, variant = 't') {
    if (typeof text !== 'string') throw new TypeError('待转换内容必须是文字。');
    if (!['simplified', 'traditional'].includes(direction)) throw new Error('未知的转换方向。');
    const target = direction === 'simplified' ? 'cn' : (variants.has(variant) ? variant : 't');
    const key = `t:${target}`;
    if (!converters.has(key)) {
      // Normalize mixed Simplified/Traditional input before choosing the output form.
      const normalize = OpenCC.Converter({ from: 'cn', to: 't' });
      const output = target === 't' ? (value) => value : OpenCC.Converter({ from: 't', to: target });
      converters.set(key, (value) => output(normalize(value)));
    }
    return converters.get(key)(text);
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // HTTP pages can lack the Clipboard API. Keep a local, gesture-driven fallback.
    }
    const focused = document.activeElement;
    const selection = window.getSelection();
    const ranges = [];
    if (selection) for (let i = 0; i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i).cloneRange());
    const inputSelection = focused && typeof focused.selectionStart === 'number'
      ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
    const temporary = document.createElement('textarea');
    temporary.value = text;
    temporary.setAttribute('aria-hidden', 'true');
    temporary.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;font-size:16px;';
    document.documentElement.append(temporary);
    let copied = false;
    try {
      temporary.focus({ preventScroll: true });
      temporary.select();
      copied = document.execCommand('copy');
    } finally {
      temporary.remove();
      focused?.focus({ preventScroll: true });
      if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
      if (inputSelection) focused.setSelectionRange(...inputSelection);
    }
    if (!copied) throw new Error('复制失败，请选中转换结果后手动复制。');
  }

  globalThis.TextSwitch = Object.freeze({ convert, copy, settings, defaults, hasChinese: (text) => /\p{Script=Han}/u.test(text) });
})();
