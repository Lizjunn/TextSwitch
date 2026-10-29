(() => {
  'use strict';
  if (globalThis.__textSwitchLoaded) return;
  globalThis.__textSwitchLoaded = true;

  let preferences = TextSwitch.defaults;
  let current = null;
  let ui = null;
  let direction = 'traditional';
  let converted = '';
  let selectionTimer;
  let suppressSelection = false;
  let pointer = null;
  let lastTarget = null;
  let sequence = 0;
  let resultPinned = false;
  let contextSelection = null;
  let pendingUserSelection = false;
  let pendingSnapshot = null;
  let positionFrame;

  chrome.storage.local.get(TextSwitch.defaults).then((value) => {
    preferences = TextSwitch.settings(value);
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    preferences = TextSwitch.settings({
      ...preferences,
      ...Object.fromEntries(Object.entries(changes).map(([key, change]) => [key, change.newValue]))
    });
    if (!preferences.floatingEnabled) hide();
    if (ui && !ui.host.hidden && ui.resultArea.hidden === false) showResult(direction);
  });

  const isInput = (element) => element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement && ['text', 'search', 'url', 'tel', 'password'].includes(element.type));
  const asElement = (node) => node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;

  function shadowRootFor(element) {
    if (element?.shadowRoot) return element.shadowRoot;
    if (!(element instanceof HTMLElement) || !chrome.dom?.openOrClosedShadowRoot) return null;
    try { return chrome.dom.openOrClosedShadowRoot(element); } catch { return null; }
  }

  function activeElement() {
    let element = document.activeElement;
    let nested;
    while ((nested = shadowRootFor(element)?.activeElement)) element = nested;
    return element;
  }

  function eventTarget(event) {
    let element = event.composedPath()[0];
    // Closed components retarget the event to their host. Chrome extensions can
    // inspect that host's shadow root without altering the page's components.
    let root;
    while ((root = shadowRootFor(element))) {
      const nested = root.elementFromPoint(event.clientX, event.clientY);
      if (!nested || nested === element) break;
      element = nested;
    }
    return element;
  }

  function selectionRange(selection, active = activeElement()) {
    let range = null;
    try {
      if (typeof selection.getComposedRanges === 'function') {
        const roots = new Set();
        for (const node of [selection.anchorNode, selection.focusNode, active, lastTarget, current?.range?.startContainer]) {
          let root = node?.getRootNode?.();
          while (root instanceof ShadowRoot) { roots.add(root); root = root.host.getRootNode(); }
        }
        const composed = selection.getComposedRanges({ shadowRoots: [...roots] })[0];
        if (composed && composed.startContainer.getRootNode() === composed.endContainer.getRootNode()) {
          range = document.createRange();
          range.setStart(composed.startContainer, composed.startOffset);
          range.setEnd(composed.endContainer, composed.endOffset);
        }
      } else if (selection.rangeCount === 1) {
        // Older Chrome exposes the internal range through the focused root.
        const root = lastTarget?.getRootNode?.();
        const local = root instanceof ShadowRoot && root.getSelection?.();
        range = (local?.rangeCount === 1 ? local : selection).getRangeAt(0).cloneRange();
      }
    } catch { /* A readable selection can still be converted and copied. */ }
    return range;
  }

  function editableRoot(node) {
    let element = asElement(node);
    if (!element?.isContentEditable) return null;
    while (element.parentElement?.isContentEditable) element = element.parentElement;
    return element;
  }

  function inPanel(event) {
    return ui && event.composedPath().includes(ui.host);
  }

  function rectFor(range, element) {
    if (pointer) return { left: pointer.x, right: pointer.x, top: pointer.y, bottom: pointer.y + 6 };
    if (range) {
      const rects = range.getClientRects();
      if (rects.length) return rects[rects.length - 1];
    }
    return element?.getBoundingClientRect() || { left: 20, right: 20, top: 20, bottom: 20 };
  }

  function capture() {
    const active = activeElement();
    if (ui && (active === ui.host || ui.shadow.contains(active))) return current;
    const element = isInput(lastTarget) && lastTarget === active ? lastTarget : active;
    if (isInput(element)) {
      if (element.type === 'password') return null;
      const start = element.selectionStart;
      const end = element.selectionEnd;
      if (start !== null && end !== null && start !== end) return {
        kind: 'input', element, start, end,
        text: element.value.slice(start, end), original: element.value,
        editable: !element.readOnly && !element.disabled,
        rect: rectFor(null, element), token: `${Date.now()}:${++sequence}`
      };
    }
    const selection = window.getSelection();
    if (!selection) return null;
    // Native shadow selections can have visible text while the outer selection
    // reports isCollapsed=true and exposes an empty, retargeted document range.
    // Selection.toString() includes visible paragraph breaks that Range.toString() omits.
    const text = selection.toString();
    if (!text.trim()) return null;
    const range = selectionRange(selection, active);
    if (!range || range.collapsed || !range.toString().trim()) {
      return { kind: 'text', text, editable: false, rect: rectFor(null, lastTarget), token: `${Date.now()}:${++sequence}` };
    }
    if (ui && (ui.shadow.contains(range.startContainer) || ui.shadow.contains(range.endContainer))) return current;
    const rangeText = range.toString();
    const startRoot = editableRoot(range.startContainer);
    const endRoot = editableRoot(range.endContainer);
    const root = startRoot && startRoot === endRoot ? startRoot : null;
    return {
      kind: 'range', range, element: root, text, rangeText,
      editable: Boolean(root), rect: rectFor(range, asElement(range.endContainer)),
      token: `${Date.now()}:${++sequence}`
    };
  }

  function sameSelection(a, b) {
    if (!a || !b || a.kind !== b.kind || a.text !== b.text) return false;
    if (a.kind === 'input') return a.element === b.element && a.start === b.start && a.end === b.end && a.original === b.original;
    if (a.kind === 'text') return true;
    return a.rangeText === b.rangeText && a.range.startContainer === b.range.startContainer && a.range.startOffset === b.range.startOffset &&
      a.range.endContainer === b.range.endContainer && a.range.endOffset === b.range.endOffset;
  }

  function announceFrame() {
    chrome.runtime.sendMessage({ type: 'TEXT_SWITCH_SELECTION_FRAME' }).catch(() => {});
  }

  function updateSelection(userInitiated = false, snapshot = null) {
    if (suppressSelection || (resultPinned && !userInitiated)) return;
    const next = snapshot || capture();
    if (!next || !TextSwitch.hasChinese(next.text)) {
      // A site's passive selection cleanup should not dismiss an open toolbar.
      if (!userInitiated && ui && !ui.host.hidden) return;
      current = null;
      hide();
      return;
    }
    if (sameSelection(current, next)) {
      if (userInitiated && preferences.floatingEnabled && ui?.host.hidden) {
        current.rect = next.rect;
        showToolbar();
      }
      return;
    }
    current = next;
    announceFrame();
    if (preferences.floatingEnabled) showToolbar();
  }

  function schedule(userInitiated = false) {
    if (resultPinned && !userInitiated) return;
    if (userInitiated) { pendingUserSelection = true; pendingSnapshot = capture(); }
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const user = pendingUserSelection;
      const snapshot = pendingSnapshot;
      pendingUserSelection = false;
      pendingSnapshot = null;
      updateSelection(user, snapshot);
    }, 90);
  }

  function createUI() {
    if (ui) return ui;
    const host = document.createElement('div');
    // Chrome's saved HTML can contain a frozen copy of an older extension panel.
    for (const existing of document.querySelectorAll('#textswitch-extension')) {
      if (existing.shadowRoot?.querySelector('.panel[aria-label="简繁切换"]')) existing.remove();
    }
    host.id = 'textswitch-extension';
    host.hidden = true;
    for (const [key, value] of Object.entries({
      all: 'initial', position: 'fixed', 'z-index': '2147483647', display: 'block',
      margin: '0', padding: '0', border: '0', width: 'max-content', 'max-width': 'calc(100vw - 16px)',
      'pointer-events': 'none', 'color-scheme': 'light'
    })) host.style.setProperty(key, value, 'important');
    host.style.setProperty('inset', 'auto', 'important');
    host.style.setProperty('background', 'transparent', 'important');
    host.style.setProperty('overflow', 'visible', 'important');
    if (typeof host.showPopover === 'function') host.setAttribute('popover', 'manual');
    // Inline display is important to resist page styles; explicitly hide via visibility.
    host.style.setProperty('visibility', 'hidden', 'important');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; color-scheme: light; }
        * { box-sizing: border-box; }
        [hidden] { display: none !important; }
        .panel { pointer-events: auto; color: #203932; background: #fff; border: 1px solid #dce7e2; border-radius: 13px; box-shadow: 0 7px 30px #133e2926, 0 2px 7px #133e2910; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; overflow: hidden; }
        .toolbar { display: flex; align-items: center; gap: 5px; padding: 6px; }
        .brand { display: grid; place-items: center; margin: 0 5px 0 2px; width: 25px; height: 25px; border-radius: 7px; color: #fff; background: #18755d; font-size: 14px; font-weight: 700; }
        button { appearance: none; border: 0; background: transparent; color: inherit; cursor: pointer; font: inherit; white-space: nowrap; border-radius: 8px; padding: 7px 12px; }
        button:hover { background: #edf5f1; }
        button:disabled { opacity: .5; cursor: default; }
        button:focus-visible, textarea:focus-visible { outline: 2px solid #18755d; outline-offset: 2px; }
        button[aria-pressed="true"] { background: #e6f3ed; color: #12694f; font-weight: 600; }
        .close { padding: 4px 8px; color: #6d8077; font-size: 19px; line-height: 25px; margin-left: auto; }
        .result-area { width: 330px; max-width: calc(100vw - 18px); padding: 10px 14px 13px; border-top: 1px solid #edf2ef; }
        .meta { display: flex; justify-content: space-between; gap: 8px; color: #78877f; font-size: 11px; margin-bottom: 8px; }
        textarea { appearance: none; display: block; width: 100%; height: 104px; min-height: 60px; max-height: 40vh; padding: 10px; resize: vertical; border: 1px solid #e2e9e4; border-radius: 8px; background: #f7faf8; color: #203932; font: 14px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; }
        .actions { display: flex; gap: 8px; margin-top: 11px; }
        .actions button { flex: 1; border: 1px solid #dce7e2; }
        .actions .primary { color: #fff; background: #18755d; border-color: #18755d; }
        .actions .primary:hover { background: #11624c; }
        .hint { margin: 9px 0 0; color: #78877f; font-size: 11px; }
        .status { color: #12694f; font-size: 12px; margin: 9px 0 0; }
        .status[data-error="true"] { color: #ae3c2f; }
        .panel { max-height: calc(100vh - 16px); overflow: auto; }
        @media (prefers-reduced-motion: no-preference) { button { transition: background .12s; } }
      </style>
      <section class="panel" aria-label="简繁切换">
        <div class="toolbar">
          <span class="brand" aria-hidden="true">文</span>
          <button data-direction="simplified" aria-pressed="false">转简体</button>
          <button data-direction="traditional" aria-pressed="false">转繁体</button>
          <button class="close" aria-label="关闭" title="关闭（Esc）">×</button>
        </div>
        <div class="result-area" hidden>
          <div class="meta"><span class="result-label">转换结果</span><span class="count"></span></div>
          <textarea class="result" aria-label="转换结果" readonly spellcheck="false"></textarea>
          <div class="actions">
            <button class="copy">复制结果</button>
            <button class="replace primary" hidden>替换选中文字</button>
          </div>
          <p class="hint"></p>
          <p class="status" role="status" aria-live="polite" hidden></p>
        </div>
      </section>`;
    const get = (selector) => shadow.querySelector(selector);
    ui = {
      host, shadow, panel: get('.panel'), resultArea: get('.result-area'), result: get('.result'),
      replace: get('.replace'), hint: get('.hint'), status: get('.status'), count: get('.count'), label: get('.result-label')
    };
    // Buttons retain the page selection. The preview itself can still be selected and copied.
    shadow.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button')) event.preventDefault();
      event.stopPropagation();
    });
    shadow.addEventListener('click', (event) => event.stopPropagation());
    shadow.querySelectorAll('[data-direction]').forEach((button) => {
      button.addEventListener('click', () => showResult(button.dataset.direction));
    });
    get('.close').addEventListener('click', () => hide());
    get('.copy').addEventListener('click', async () => {
      try { await TextSwitch.copy(converted); status('已复制到剪贴板'); }
      catch (error) { status(error.message, true); }
    });
    ui.replace.addEventListener('click', () => {
      const outcome = replace(converted, current?.token);
      if (outcome.ok) { ui.replace.hidden = true; status('已替换选中文字'); }
      else status(outcome.error, true);
    });
    document.documentElement.append(host);
    return ui;
  }

  function status(message, error = false) {
    if (!ui) return;
    ui.status.textContent = message;
    ui.status.dataset.error = String(error);
    ui.status.hidden = false;
    position();
  }

  function position() {
    if (!ui || !current) return;
    const margin = 8;
    const rect = current.rect;
    const width = ui.host.getBoundingClientRect().width;
    const height = ui.host.getBoundingClientRect().height;
    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft || 0;
    const viewportTop = viewport?.offsetTop || 0;
    const viewportWidth = viewport?.width || window.innerWidth;
    const viewportHeight = viewport?.height || window.innerHeight;
    const left = Math.max(viewportLeft + margin, Math.min(rect.left, viewportLeft + viewportWidth - width - margin));
    let top = rect.bottom + 9;
    if (top + height > viewportTop + viewportHeight - margin) top = rect.top - height - 9;
    top = Math.max(viewportTop + margin, Math.min(top, viewportTop + viewportHeight - height - margin));
    ui.host.style.setProperty('left', `${left}px`, 'important');
    ui.host.style.setProperty('top', `${top}px`, 'important');
  }

  function reveal() {
    createUI();
    if (!ui.host.isConnected) document.documentElement.append(ui.host);
    ui.host.hidden = false;
    ui.host.style.setProperty('visibility', 'visible', 'important');
    if (ui.host.hasAttribute('popover') && !ui.host.matches(':popover-open')) {
      try { ui.host.showPopover(); } catch { /* fixed-position fallback for older browsers */ }
    }
    position();
  }

  function showToolbar() {
    resultPinned = false;
    createUI();
    ui.resultArea.hidden = true;
    ui.status.hidden = true;
    ui.shadow.querySelectorAll('[data-direction]').forEach((button) => button.setAttribute('aria-pressed', 'false'));
    reveal();
  }

  function showResult(nextDirection) {
    if (!current || !TextSwitch.hasChinese(current.text)) return;
    createUI();
    try { converted = TextSwitch.convert(current.text, nextDirection, preferences.traditionalVariant); }
    catch { status('转换失败，请重新选择文字。', true); return; }
    direction = nextDirection;
    resultPinned = true;
    clearTimeout(selectionTimer);
    pendingUserSelection = false;
    pendingSnapshot = null;
    ui.result.value = converted;
    ui.shadow.querySelector('.copy').disabled = false;
    ui.resultArea.hidden = false;
    ui.status.hidden = true;
    ui.replace.hidden = !current.editable;
    ui.label.textContent = nextDirection === 'simplified' ? '简体结果' : '繁体结果';
    ui.count.textContent = `${Array.from(converted).length} 字`;
    ui.hint.textContent = current.editable ? '只替换选中部分，保留输入框里的其他文字。' : '本地转换，文字不会上传。';
    ui.shadow.querySelectorAll('[data-direction]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.direction === direction)));
    reveal();
  }

  function showSelectionHint() {
    createUI();
    current = { kind: 'text', text: '', editable: false, rect: rectFor(null, lastTarget) };
    converted = '';
    resultPinned = true;
    ui.result.value = '';
    ui.resultArea.hidden = false;
    ui.replace.hidden = true;
    ui.shadow.querySelector('.copy').disabled = true;
    ui.label.textContent = '未选中中文';
    ui.count.textContent = '';
    ui.status.hidden = true;
    ui.hint.textContent = '请先在网页中选中中文，再点击转简体或转繁体。';
    reveal();
  }

  function hide() {
    resultPinned = false;
    clearTimeout(selectionTimer);
    pendingUserSelection = false;
    pendingSnapshot = null;
    if (!ui) return;
    ui.host.hidden = true;
    ui.host.style.setProperty('visibility', 'hidden', 'important');
    if (ui.host.hasAttribute('popover') && ui.host.matches(':popover-open')) ui.host.hidePopover();
  }

  function reposition() {
    if (!ui || ui.host.hidden || !current || positionFrame) return;
    positionFrame = requestAnimationFrame(() => {
      positionFrame = null;
      if (!current || ui.host.hidden) return;
      const lastPointer = pointer;
      pointer = null;
      if (current.kind !== 'text') current.rect = rectFor(current.range, current.element);
      pointer = lastPointer;
      position();
    });
  }

  function valid(snapshot) {
    if (!snapshot?.editable || !snapshot.element?.isConnected) return false;
    if (snapshot.kind === 'input') {
      return !snapshot.element.readOnly && !snapshot.element.disabled && snapshot.element.type !== 'password' &&
        snapshot.element.value === snapshot.original;
    }
    return snapshot.element.isContentEditable && snapshot.range.startContainer.isConnected && snapshot.range.endContainer.isConnected &&
      editableRoot(snapshot.range.startContainer) === snapshot.element && editableRoot(snapshot.range.endContainer) === snapshot.element &&
      snapshot.range.toString() === snapshot.rangeText;
  }

  function replace(text, token) {
    const snapshot = current;
    if (typeof text !== 'string' || !snapshot || snapshot.token !== token || !valid(snapshot)) {
      return { ok: false, error: '原文字或输入框已变化，请重新选中文字后再替换。' };
    }
    clearTimeout(selectionTimer);
    suppressSelection = true;
    try {
      const element = snapshot.element;
      element.focus({ preventScroll: true });
      if (snapshot.kind === 'input') {
        element.setSelectionRange(snapshot.start, snapshot.end);
      } else {
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(snapshot.range.cloneRange());
      }
      const before = new InputEvent('beforeinput', {
        bubbles: true, composed: true, cancelable: true, inputType: 'insertReplacementText', data: text
      });
      if (!element.dispatchEvent(before)) return { ok: false, error: '此编辑器阻止了替换操作，可以复制结果后粘贴。' };
      // A page may modify its value in beforeinput; never overwrite that newer content.
      if (!valid(snapshot)) return { ok: false, error: '原文字已变化，请重新选中后再替换。' };
      const active = activeElement();
      if (snapshot.kind === 'input') {
        if (active !== element || element.selectionStart !== snapshot.start || element.selectionEnd !== snapshot.end) {
          return { ok: false, error: '编辑器改变了选区，请重新选中文字，或复制结果后粘贴。' };
        }
      } else {
        const selection = window.getSelection();
        const selected = selection && selectionRange(selection, active);
        if (editableRoot(active) !== element || !selected || selected.startContainer !== snapshot.range.startContainer ||
          selected.startOffset !== snapshot.range.startOffset || selected.endContainer !== snapshot.range.endContainer ||
          selected.endOffset !== snapshot.range.endOffset) {
          return { ok: false, error: '编辑器改变了选区，请重新选中文字，或复制结果后粘贴。' };
        }
      }
      // Chrome's editing command retains native Undo and notifies controlled inputs.
      let inserted = false;
      try { inserted = document.execCommand('insertText', false, text); } catch { /* use DOM fallback */ }
      if (!inserted) {
        if (!valid(snapshot)) return { ok: false, error: '编辑器内容已变化，请重新选中后再替换。' };
        if (snapshot.kind === 'input') {
          const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
          setter.call(element, snapshot.original.slice(0, snapshot.start) + text + snapshot.original.slice(snapshot.end));
          element.setSelectionRange(snapshot.start + text.length, snapshot.start + text.length);
        } else {
          const range = snapshot.range;
          range.deleteContents();
          const node = document.createTextNode(text);
          range.insertNode(node);
          range.setStartAfter(node);
          range.collapse(true);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }
        element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: text }));
      }
      current = null;
      return { ok: true };
    } catch {
      return { ok: false, error: '此编辑器暂不支持直接替换，可以复制结果后粘贴。' };
    } finally {
      setTimeout(() => { suppressSelection = false; }, 120);
    }
  }

  window.addEventListener('pointerdown', (event) => {
    if (inPanel(event)) return;
    lastTarget = eventTarget(event);
    if (event.button !== 0) return;
    contextSelection = null;
    hide();
  }, true);
  window.addEventListener('pointerup', (event) => {
    if (inPanel(event) || event.button !== 0) return;
    lastTarget = eventTarget(event);
    pointer = { x: event.clientX, y: event.clientY };
    schedule(true);
  }, true);
  window.addEventListener('keyup', (event) => {
    if (inPanel(event)) return;
    if (event.key === 'Escape') { hide(); return; }
    pointer = null;
    schedule(true);
  }, true);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && ui && !ui.host.hidden) { hide(); }
  }, true);
  window.addEventListener('selectionchange', () => schedule(), true);
  window.addEventListener('contextmenu', (event) => {
    if (inPanel(event)) return;
    clearTimeout(selectionTimer);
    pendingUserSelection = false;
    pendingSnapshot = null;
    lastTarget = eventTarget(event);
    pointer = { x: event.clientX, y: event.clientY };
    const next = capture();
    if (next && TextSwitch.hasChinese(next.text)) {
      if (!sameSelection(current, next)) current = next;
      announceFrame();
    } else current = null;
    contextSelection = current;
  }, true);
  window.addEventListener('scroll', (event) => { if (!inPanel(event)) reposition(); }, true);
  window.addEventListener('resize', reposition);

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (_sender.id !== chrome.runtime.id) return;
    if (['TEXT_SWITCH_BULK_CONVERT', 'TEXT_SWITCH_BULK_UNDO', 'TEXT_SWITCH_BULK_STATE'].includes(message.type)) {
      const mutating = message.type !== 'TEXT_SWITCH_BULK_STATE';
      if (mutating) suppressSelection = true;
      try {
        const result = message.type === 'TEXT_SWITCH_BULK_CONVERT' ? TextSwitchBulk.run(message.direction, message.variant) :
          message.type === 'TEXT_SWITCH_BULK_UNDO' ? TextSwitchBulk.undo() : TextSwitchBulk.state();
        if (result.changed) { current = null; contextSelection = null; hide(); }
        respond(result);
      } catch (error) { respond({ ok: false, error: error.message || '批量转换失败，请刷新网页后重试。' }); }
      finally { if (mutating) setTimeout(() => { suppressSelection = false; }, 120); }
    } else if (message.type === 'TEXT_SWITCH_CONVERT') {
      clearTimeout(selectionTimer);
      const next = capture();
      const matches = (snapshot) => snapshot && (!message.text || snapshot.text === message.text ||
        snapshot.text.replace(/\s+/g, ' ').trim() === message.text.replace(/\s+/g, ' ').trim());
      if (matches(next)) {
        if (!sameSelection(current, next)) current = next;
      } else if (matches(contextSelection)) {
        current = contextSelection;
      } else if (!matches(current)) {
        // Chrome can collapse a DOM selection when opening its context menu.
        // A text-only preview remains available, without a replacement target.
        current = message.text ? { kind: 'text', text: message.text, editable: false,
          rect: rectFor(null, null), token: `${Date.now()}:${++sequence}` } : null;
      }
      const ok = Boolean(current && TextSwitch.hasChinese(current.text));
      if (ok) showResult(message.direction);
      else showSelectionHint();
      respond({ ok });
    } else if (message.type === 'TEXT_SWITCH_GET_SELECTION') {
      clearTimeout(selectionTimer);
      const next = capture();
      if (!resultPinned && next && !sameSelection(current, next)) current = next;
      // Preserve a captured selection across popup focus, but only return a live target.
      const live = current && (current.kind === 'text' || (current.kind === 'input' ? current.element.isConnected && current.element.value === current.original :
        current.range.startContainer.isConnected && current.range.toString() === current.rangeText));
      if (!live || !TextSwitch.hasChinese(current.text)) {
        respond({ ok: false, error: '先在网页或输入框中选中中文，也可以在这里粘贴文字。' });
      } else {
        respond({ ok: true, text: current.text, editable: valid(current), token: current.token });
      }
    } else if (message.type === 'TEXT_SWITCH_REPLACE') {
      const result = replace(message.text, message.token);
      if (result.ok) hide();
      respond(result);
    }
  });
})();
