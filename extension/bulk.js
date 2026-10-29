(() => {
  'use strict';
  let previous = [];
  const inputTypes = new Set(['text', 'search', 'url', 'tel']);

  function shadowRoot(element) {
    if (element.shadowRoot) return element.shadowRoot;
    try { return chrome.dom?.openOrClosedShadowRoot(element); } catch { return null; }
  }

  function parent(element) {
    return element.assignedSlot || element.parentElement || element.getRootNode()?.host ||
      element.ownerDocument.defaultView.frameElement;
  }

  function visible(element) {
    if (!element.isConnected) return false;
    if (element.checkVisibility && !element.checkVisibility({
      checkOpacity: true, checkVisibilityCSS: true
    })) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (element.ownerDocument.defaultView.getComputedStyle(element).visibility !== 'visible') return false;
    for (let node = element; node; node = parent(node)) {
      if (node.hidden || node.inert || node.getAttribute('aria-hidden') === 'true') return false;
      const style = node.ownerDocument.defaultView.getComputedStyle(node);
      if (style.display === 'none' || style.contentVisibility === 'hidden' || Number(style.opacity) === 0) return false;
    }
    // No viewport intersection check: fields below the fold still belong to the page.
    return true;
  }

  function editable(element) {
    return (element.localName === 'textarea' || (element.localName === 'input' && inputTypes.has(element.type))) &&
      !element.readOnly && !element.matches(':disabled') && element.getAttribute('aria-disabled') !== 'true' && visible(element);
  }

  function collect() {
    const fields = [];
    const documents = new Set();
    let inaccessibleFrames = 0;
    function scan(root) {
      for (const element of root.querySelectorAll('*')) {
        // Exclude the extension's preview, including frozen copies in saved HTML.
        if (element.id === 'textswitch-extension') continue;
        if (editable(element)) fields.push(element);
        const shadow = shadowRoot(element);
        if (shadow) scan(shadow);
        if (['iframe', 'frame'].includes(element.localName) && visible(element)) {
          try {
            const doc = element.contentDocument;
            if (!doc) { inaccessibleFrames++; continue; }
            if (!documents.has(doc)) { documents.add(doc); scan(doc); }
          } catch { inaccessibleFrames++; }
        }
      }
    }
    documents.add(document);
    scan(document);
    return { fields, inaccessibleFrames };
  }

  function write(element, expected, value) {
    if (!editable(element) || element.value !== expected) return false;
    const view = element.ownerDocument.defaultView;
    const before = new view.InputEvent('beforeinput', {
      bubbles: true, composed: true, cancelable: true, inputType: 'insertReplacementText', data: value
    });
    if (!element.dispatchEvent(before) || !editable(element) || element.value !== expected) return false;
    const selection = typeof element.selectionStart === 'number'
      ? [element.selectionStart, element.selectionEnd, element.selectionDirection] : null;
    const prototype = element.localName === 'textarea' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
    // Use the native setter so controlled inputs can observe the subsequent input event.
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    if (selection) element.setSelectionRange(Math.min(selection[0], value.length), Math.min(selection[1], value.length), selection[2]);
    element.dispatchEvent(new view.InputEvent('input', {
      bubbles: true, composed: true, inputType: 'insertReplacementText', data: value
    }));
    element.dispatchEvent(new view.Event('change', { bubbles: true, composed: true }));
    return element.isConnected && element.value === value;
  }

  function state() {
    previous = previous.filter(entry => entry.element.isConnected && entry.element.value === entry.after);
    return { ok: true, undoAvailable: previous.length > 0 };
  }

  function run(direction, variant) {
    if (!['simplified', 'traditional'].includes(direction)) throw new Error('请选择转简体或转繁体。');
    const { fields, inaccessibleFrames } = collect();
    // Snapshot every value before notifying the page: one field's events may update another.
    const plan = fields.map(element => {
      const before = element.value;
      return { element, before, after: TextSwitch.hasChinese(before) ? TextSwitch.convert(before, direction, variant) : before };
    });
    const changes = [];
    let unchanged = 0;
    let skipped = 0;
    for (const entry of plan) {
      if (entry.before === entry.after) { unchanged++; continue; }
      try {
        if (write(entry.element, entry.before, entry.after)) changes.push(entry);
        else skipped++;
      } catch { skipped++; }
    }
    if (changes.length) previous = changes;
    return { ...state(), changed: changes.length, unchanged, skipped, inaccessibleFrames };
  }

  function undo() {
    const changes = previous;
    previous = [];
    let changed = 0;
    for (const entry of changes) {
      try { if (write(entry.element, entry.after, entry.before)) changed++; } catch { /* Keep newer page content. */ }
    }
    return { ...state(), changed, skipped: changes.length - changed, inaccessibleFrames: 0 };
  }

  globalThis.TextSwitchBulk = Object.freeze({ run, undo, state });
})();
