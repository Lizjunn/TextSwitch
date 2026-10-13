const { test, expect, chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
let context, worker, extensionId, server, base, profile;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/frame') {
      res.end('<!doctype html><meta charset="utf-8"><textarea id="frame-input">前缀汉字转换后缀</textarea>');
    } else {
      res.end(fs.readFileSync(path.join(root, 'demo/index.html'), 'utf8').replace('</body>', `
        <input id="password" type="password" value="密码汉字">
        <input id="english" value="Hello World">
        <iframe id="frame" src="/frame" style="width:500px;height:150px"></iframe>
        <script>
          window.inputEvents = [];
          document.addEventListener('input', event => window.inputEvents.push({ id:event.target.id, value:event.target.value, inputType:event.inputType }));
          const host = document.createElement('div'); host.id='shadow-host';
          host.attachShadow({mode:'open'}).innerHTML='<input id="shadow-input" value="前缀汉字转换后缀">'; document.body.append(host);
        </script></body>`));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'textswitch-test-'));
  const extension = path.join(root, 'extension');
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 1100, height: 850 }
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
});
test.afterAll(async () => {
  await context?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  // Only the explicitly created temporary browser profile is removed.
  if (profile && path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('textswitch-test-')) fs.rmSync(profile, { recursive: true, force: true });
});

async function page() {
  const tab = await context.newPage();
  await tab.goto(base);
  await worker.evaluate(() => chrome.storage.local.set({ floatingEnabled: true, traditionalVariant: 't' }));
  return tab;
}
async function selectInput(tab, selector, start, end) {
  const input = tab.locator(selector);
  await input.scrollIntoViewIfNeeded();
  await input.evaluate((el, { start, end }) => { el.focus(); el.setSelectionRange(start, end); }, { start, end });
  await expect(tab.locator('#textswitch-extension')).toBeVisible();
}
async function selectText(tab, selector, start = 0, end = null) {
  await tab.locator(selector).scrollIntoViewIfNeeded();
  await tab.locator(selector).evaluate((el, { start, end }) => {
    const text = el.firstChild;
    const range = document.createRange(); range.setStart(text, start); range.setEnd(text, end ?? text.length);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  }, { start, end });
  await expect(tab.locator('#textswitch-extension')).toBeVisible();
}
const panel = (tab) => tab.locator('#textswitch-extension');

async function dragText(tab, target, start = 0, end = 4) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.evaluate((el, { start, end }) => {
    const range = document.createRange();
    range.setStart(el.firstChild, start); range.setEnd(el.firstChild, end);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + 1, y: rect.top + rect.height / 2, right: rect.right - 1 };
  }, { start, end });
  // Establish the selection through browser input, never Selection.addRange().
  await tab.mouse.move(box.x, box.y); await tab.mouse.down();
  await tab.mouse.move(box.right, box.y, { steps: 8 }); await tab.mouse.up();
  return box;
}

test('native mouse selection inside nested shadow components shows the toolbar', async () => {
  const tab = await page();
  await tab.locator('#shadow-host').evaluate(host => {
    const nested = document.createElement('bili-comment-renderer');
    nested.attachShadow({mode:'open'}).innerHTML = '<p id="native-comment" style="font:24px sans-serif">汉字转换，后台干杯</p>';
    host.shadowRoot.append(nested);
  });
  await dragText(tab, tab.locator('#native-comment'));
  expect(await tab.evaluate(() => ({ text: window.getSelection().toString(), collapsed: window.getSelection().isCollapsed })))
    .toEqual({ text: '汉字转换', collapsed: true });
  await expect(panel(tab)).toBeVisible();
  await panel(tab).getByRole('button', { name: '转繁体', exact: true }).click();
  await expect(panel(tab).getByRole('textbox')).toHaveValue('漢字轉換');
  await panel(tab).getByRole('button', { name: '复制结果' }).click();
  await expect(panel(tab).getByRole('status')).toHaveText('已复制到剪贴板');
  await tab.close();
});

test('native mouse selection in a closed shadow component is readable', async () => {
  const tab = await page();
  const geometry = await tab.evaluate(() => {
    const host = document.createElement('bili-rich-text');
    const shadow = host.attachShadow({mode:'closed'});
    shadow.innerHTML = '<p style="font:24px sans-serif">汉字转换，后台干杯</p>';
    document.body.prepend(host);
    const range = document.createRange(); range.setStart(shadow.querySelector('p').firstChild,0); range.setEnd(shadow.querySelector('p').firstChild,4);
    const rect = range.getBoundingClientRect();
    return {x:rect.left+1,y:rect.top+rect.height/2,right:rect.right-1};
  });
  await tab.mouse.move(geometry.x,geometry.y); await tab.mouse.down();
  await tab.mouse.move(geometry.right,geometry.y,{steps:8}); await tab.mouse.up();
  expect(await tab.evaluate(() => window.getSelection().toString())).toBe('汉字转换');
  await expect(panel(tab)).toBeVisible();
  await panel(tab).getByRole('button', {name:'转繁体',exact:true}).click();
  await expect(panel(tab).getByRole('textbox')).toHaveValue('漢字轉換');
  await expect(panel(tab).getByRole('button', {name:'替换选中文字'})).toBeHidden();
  await tab.close();
});

test('a closed shadow input can replace a keyboard selection without changing surrounding text', async () => {
  const tab = await page();
  const input = await tab.evaluateHandle(() => {
    const host=document.createElement('div'); document.body.prepend(host);
    const input=document.createElement('input'); input.value='前缀汉字转换后缀';
    host.attachShadow({mode:'closed'}).append(input);
    return input;
  });
  const box=await input.evaluate(el=>{const rect=el.getBoundingClientRect();return {x:rect.left+10,y:rect.top+rect.height/2};});
  await tab.mouse.click(box.x,box.y);
  await tab.keyboard.press('Home');
  for(let i=0;i<2;i++) await tab.keyboard.press('ArrowRight');
  for(let i=0;i<4;i++) await tab.keyboard.press('Shift+ArrowRight');
  await expect(panel(tab)).toBeVisible();
  await panel(tab).getByRole('button',{name:'转繁体',exact:true}).click();
  await expect(panel(tab).getByRole('textbox')).toHaveValue('漢字轉換');
  await panel(tab).getByRole('button',{name:'替换选中文字'}).click();
  await expect(panel(tab).getByRole('status')).toHaveText('已替换选中文字');
  expect(await input.evaluate(el=>el.value)).toBe('前缀漢字轉換后缀');
  await input.dispose(); await tab.close();
});

test('native mouse selection in shadow rich text replaces the precise range', async () => {
  const tab = await page();
  await tab.locator('#shadow-host').evaluate(host => {
    const editor=document.createElement('div');editor.id='native-shadow-editor';editor.contentEditable='true';
    editor.textContent='前缀汉字转换后缀';editor.style.font='24px sans-serif';host.shadowRoot.append(editor);
  });
  await dragText(tab,tab.locator('#native-shadow-editor'),2,6);
  await expect(panel(tab)).toBeVisible();
  await panel(tab).getByRole('button',{name:'转繁体',exact:true}).click();
  await expect(panel(tab).getByRole('textbox')).toHaveValue('漢字轉換');
  await panel(tab).getByRole('button',{name:'替换选中文字'}).click();
  await expect(tab.locator('#native-shadow-editor')).toHaveText('前缀漢字轉換后缀');
  await tab.close();
});

test('right-click conversion uses native shadow selection when Chrome supplies no selectionText', async () => {
  const tab = await page();
  await worker.evaluate(() => chrome.storage.local.set({floatingEnabled:false}));
  await tab.locator('#shadow-host').evaluate(host => {
    const comment = document.createElement('p'); comment.id='context-comment';
    comment.style.font='24px sans-serif'; comment.textContent='汉字转换，后台干杯';
    host.shadowRoot.append(comment);
  });
  const box = await dragText(tab,tab.locator('#context-comment'));
  await tab.mouse.click((box.x+box.right)/2,box.y,{button:'right'});
  await tab.evaluate(() => window.getSelection().removeAllRanges());
  await worker.evaluate(async () => {
    const [active] = await chrome.tabs.query({active:true,currentWindow:true});
    await chrome.tabs.sendMessage(active.id,{type:'TEXT_SWITCH_CONVERT',direction:'traditional'},{frameId:0});
  });
  await expect(panel(tab).getByRole('textbox')).toHaveValue('漢字轉換');
  await tab.close();
});

test('a page stopping document pointer events cannot suppress the selection toolbar', async () => {
  const tab = await page();
  await tab.evaluate(() => {
    for (const type of ['pointerdown','pointerup','contextmenu']) document.addEventListener(type,e=>e.stopImmediatePropagation(),true);
  });
  await dragText(tab,tab.locator('#article'));
  await expect(panel(tab)).toBeVisible();
  await panel(tab).getByRole('button',{name:'转繁体',exact:true}).click();
  await expect(panel(tab).getByRole('textbox')).toHaveValue('漢字轉換');
  await tab.close();
});

test('web selection converts both ways and only offers copy', async () => {
  const tab = await page();
  await selectText(tab, '#article', 0, 4);
  await panel(tab).getByRole('button', { name: '转繁体', exact: true }).click();
  await expect(panel(tab).getByRole('textbox', { name: '转换结果' })).toHaveValue('漢字轉換');
  await expect(panel(tab).getByRole('button', { name: '替换选中文字' })).toBeHidden();
  await panel(tab).getByRole('button', { name: '转简体', exact: true }).click();
  await expect(panel(tab).getByRole('textbox', { name: '转换结果' })).toHaveValue('汉字转换');
  await tab.close();
});
test('partial input replacement preserves surrounding text and emits input', async () => {
  const tab = await page();
  await selectInput(tab, '#single', 3, 7);
  await panel(tab).getByRole('button', { name: '转繁体', exact: true }).click();
  await panel(tab).getByRole('button', { name: '替换选中文字' }).click();
  await expect(tab.locator('#single')).toHaveValue('前缀：漢字轉換，头发发展：后缀');
  expect(await tab.evaluate(() => window.inputEvents.some((event) => event.id === 'single'))).toBe(true);
  await expect(panel(tab).getByRole('status')).toHaveText('已替换选中文字');
  await tab.close();
});
test('native undo restores the replaced input selection', async () => {
  const tab = await page();
  await selectInput(tab, '#single', 3, 7);
  await panel(tab).getByRole('button', { name: '转繁体', exact: true }).click();
  await panel(tab).getByRole('button', { name: '替换选中文字' }).click();
  await tab.locator('#single').press('Control+z');
  await expect(tab.locator('#single')).toHaveValue('前缀：汉字转换，头发发展：后缀');
  await tab.close();
});
test('multiline textarea replacement retains newlines', async () => {
  const tab = await page();
  await selectInput(tab, '#multiline', 8, 19);
  await panel(tab).getByRole('button', { name: '转繁体', exact: true }).click();
  await panel(tab).getByRole('button', { name: '替换选中文字' }).click();
  await expect(tab.locator('#multiline')).toHaveValue('第一行保持不变\n漢字轉換，後臺乾杯\n第三行保持不变');
  await tab.close();
});
test('rich text spanning nodes replaces only the selection', async () => {
  const tab = await page();
  await tab.locator('#rich').evaluate((el) => {
    el.focus(); const range = document.createRange();
    range.setStart(el.querySelector('strong').firstChild, 0);
    range.setEnd(el.querySelector('em').firstChild, 2);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  });
  await expect(panel(tab)).toBeVisible();
  await panel(tab).getByRole('button', { name: '转繁体', exact: true }).click();
  await panel(tab).getByRole('button', { name: '替换选中文字' }).click();
  await expect(tab.locator('#rich')).toHaveText('前缀：漢字轉換：后缀');
  await tab.close();
});
test('read-only text can be converted but cannot be replaced', async () => {
  const tab = await page();
  await selectInput(tab, '#readonly', 5, 9);
  await panel(tab).getByRole('button', { name: '转简体', exact: true }).click();
  await expect(panel(tab).getByRole('textbox')).toHaveValue('汉字转换');
  await expect(panel(tab).getByRole('button', { name: '替换选中文字' })).toBeHidden();
  await tab.close();
});
test('rich text paragraph breaks remain in preview and replacement', async () => {
  const tab = await page();
  await tab.locator('#rich').evaluate((el) => {
    el.innerHTML='<div>汉字转换</div><div>后台干杯</div>';
    el.focus(); const range=document.createRange(); range.selectNodeContents(el);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  });
  await expect(panel(tab)).toBeVisible();
  await panel(tab).getByRole('button', { name: '转繁体', exact: true }).click();
  await expect(panel(tab).getByRole('textbox')).toHaveValue('漢字轉換\n後臺乾杯');
  await panel(tab).getByRole('button', { name: '替换选中文字' }).click();
  expect(await tab.locator('#rich').innerText()).toBe('漢字轉換\n後臺乾杯');
  await tab.close();
});
test('password and non-Chinese selections never trigger a toolbar', async () => {
  const tab = await page();
  for (const selector of ['#password', '#english']) {
    await tab.locator(selector).evaluate((el) => { el.focus(); el.select(); });
    await tab.waitForTimeout(160);
    await expect(panel(tab)).toBeHidden();
  }
  await tab.close();
});
test('stale input content is protected from replacement', async () => {
  const tab = await page();
  await selectInput(tab, '#single', 3, 7);
  await panel(tab).getByRole('button', { name: '转繁体', exact: true }).click();
  await tab.locator('#single').evaluate((el) => { el.value = '另一段最新内容'; });
  await panel(tab).getByRole('button', { name: '替换选中文字' }).click();
  await expect(tab.locator('#single')).toHaveValue('另一段最新内容');
  await expect(panel(tab).getByRole('status')).toContainText('已变化');
  await tab.close();
});
test('an editor can cancel beforeinput and use copy instead', async () => {
  const tab = await page();
  await tab.locator('#single').evaluate((el) => el.addEventListener('beforeinput', (event) => event.preventDefault()));
  await selectInput(tab, '#single', 3, 7);
  await panel(tab).getByRole('button', { name: '转繁体', exact: true }).click();
  await panel(tab).getByRole('button', { name: '替换选中文字' }).click();
  await expect(tab.locator('#single')).toHaveValue('前缀：汉字转换，头发发展：后缀');
  await expect(panel(tab).getByRole('status')).toContainText('阻止');
  await tab.close();
});
test('copy writes exactly the conversion result to the clipboard', async () => {
  const tab = await page();
  await context.grantPermissions(['clipboard-read'], { origin: base });
  await selectText(tab, '#article', 0, 4);
  await panel(tab).getByRole('button', { name: '转繁体', exact: true }).click();
  await panel(tab).getByRole('button', { name: '复制结果' }).click();
  await expect(panel(tab).getByRole('status')).toHaveText('已复制到剪贴板');
  expect(await tab.evaluate(() => navigator.clipboard.readText())).toBe('漢字轉換');
  await tab.close();
});
test('an input inside an open shadow root can be replaced', async () => {
  const tab = await page();
  await selectInput(tab, '#shadow-input', 2, 6);
  await panel(tab).getByRole('button', { name: '转繁体', exact: true }).click();
  await panel(tab).getByRole('button', { name: '替换选中文字' }).click();
  await expect(tab.locator('#shadow-input')).toHaveValue('前缀漢字轉換后缀');
  await tab.close();
});
test('iframe selections convert and replace within the correct frame', async () => {
  const tab = await page();
  const frame = tab.frameLocator('#frame');
  await frame.locator('#frame-input').evaluate((el) => { el.focus(); el.setSelectionRange(2, 6); });
  await expect(frame.locator('#textswitch-extension')).toBeVisible();
  await frame.getByRole('button', { name: '转繁体', exact: true }).click();
  await frame.getByRole('button', { name: '替换选中文字' }).click();
  await expect(frame.locator('#frame-input')).toHaveValue('前缀漢字轉換后缀');
  await tab.close();
});
test('right-click message opens a preview even with floating toolbar disabled', async () => {
  const tab = await page();
  await worker.evaluate(() => chrome.storage.local.set({ floatingEnabled: false }));
  await tab.locator('#single').evaluate((el) => { el.focus(); el.setSelectionRange(3, 7); });
  await tab.waitForTimeout(160);
  await expect(panel(tab)).toBeHidden();
  await worker.evaluate(async () => {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(active.id, { type: 'TEXT_SWITCH_CONVERT', direction: 'traditional', text: '汉字转换' }, { frameId: 0 });
  });
  await expect(panel(tab).getByRole('textbox')).toHaveValue('漢字轉換');
  await expect(panel(tab).getByRole('button', { name: '替换选中文字' })).toBeVisible();
  await tab.close();
});
test('popup performs manual conversion, copying and persists preferences', async () => {
  const tab = await context.newPage();
  await tab.goto(`chrome-extension://${extensionId}/popup.html`);
  await tab.locator('#source').fill('头发发展，后台干杯');
  await expect(tab.locator('#result')).toHaveValue('頭髮發展，後臺乾杯');
  await tab.locator('#copy').click();
  await expect(tab.locator('#status')).toHaveText('已复制到剪贴板');
  await tab.getByRole('button', { name: '简 转换为简体' }).click();
  await expect(tab.locator('#result')).toHaveValue('头发发展，后台干杯');
  await tab.locator('summary').click();
  await tab.locator('#variant').selectOption('tw');
  await tab.locator('#floating').uncheck();
  await tab.reload();
  await expect(tab.locator('#variant')).toHaveValue('tw');
  await expect(tab.locator('#floating')).not.toBeChecked();
  await tab.close();
});
test('popup messaging returns and replaces the captured input selection', async () => {
  const tab = await page();
  await selectInput(tab, '#single', 3, 7);
  // Read via an extension page while the original page remains the active tab,
  // matching the toolbar popup's currentWindow/active behavior.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await tab.bringToFront();
  await popup.evaluate(() => document.querySelector('#read-selection').click());
  await expect(popup.locator('#source')).toHaveValue('汉字转换');
  await expect(popup.locator('#result')).toHaveValue('漢字轉換');
  await expect(popup.locator('#replace')).toBeVisible();
  await popup.evaluate(() => document.querySelector('#replace').click());
  await expect(popup.locator('#status')).toHaveText('已替换输入框中选中的文字');
  await expect(tab.locator('#single')).toHaveValue('前缀：漢字轉換，头发发展：后缀');
  await popup.close(); await tab.close();
});
test('moving the caret in beforeinput never replaces an unrelated part of the input', async () => {
  const tab = await page();
  await tab.locator('#single').evaluate((el) => el.addEventListener('beforeinput', () => el.setSelectionRange(0, 0)));
  await selectInput(tab, '#single', 3, 7);
  await panel(tab).getByRole('button', { name: '转繁体', exact: true }).click();
  await panel(tab).getByRole('button', { name: '替换选中文字' }).click();
  await expect(tab.locator('#single')).toHaveValue('前缀：汉字转换，头发发展：后缀');
  await expect(panel(tab).getByRole('status')).toContainText('改变了选区');
  await tab.close();
});
test('copy fallback works on an insecure HTTP page and preserves the input selection', async () => {
  const url = 'http://textswitch.test/';
  await context.route(url, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(root, 'demo/index.html'), 'utf8') }));
  const tab = await context.newPage();
  await tab.goto(url);
  await worker.evaluate(() => chrome.storage.local.set({ floatingEnabled: true, traditionalVariant: 't' }));
  expect(await tab.evaluate(() => window.isSecureContext)).toBe(false);
  await selectInput(tab, '#single', 3, 7);
  await panel(tab).getByRole('button', { name: '转繁体', exact: true }).click();
  await panel(tab).getByRole('button', { name: '复制结果' }).click();
  await expect(panel(tab).getByRole('status')).toHaveText('已复制到剪贴板');
  expect(await tab.locator('#single').evaluate((el) => [el.selectionStart, el.selectionEnd])).toEqual([3, 7]);
  const reader = await context.newPage();
  await reader.goto(base);
  expect(await reader.evaluate(() => navigator.clipboard.readText())).toBe('漢字轉換');
  await reader.close(); await tab.close();
  await context.unroute(url);
});
test('manual popup edits detach the original replacement target', async () => {
  const tab = await page();
  await selectInput(tab, '#single', 3, 7);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await tab.bringToFront();
  await popup.evaluate(() => document.querySelector('#read-selection').click());
  await expect(popup.locator('#replace')).toBeVisible();
  await popup.evaluate(() => {
    const source = document.querySelector('#source'); source.value='另一段文字'; source.dispatchEvent(new Event('input', {bubbles:true}));
  });
  await expect(popup.locator('#replace')).toBeHidden();
  await expect(tab.locator('#single')).toHaveValue('前缀：汉字转换，头发发展：后缀');
  await popup.close(); await tab.close();
});
test('popup reads an iframe selection and replaces the same frame', async () => {
  const tab = await page();
  const frame = tab.frameLocator('#frame');
  await frame.locator('#frame-input').evaluate((el) => { el.focus(); el.setSelectionRange(2, 6); });
  await expect(frame.locator('#textswitch-extension')).toBeVisible();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await tab.bringToFront();
  await popup.evaluate(() => document.querySelector('#read-selection').click());
  await expect(popup.locator('#source')).toHaveValue('汉字转换');
  await popup.evaluate(() => document.querySelector('#replace').click());
  await expect(popup.locator('#status')).toHaveText('已替换输入框中选中的文字');
  await expect(frame.locator('#frame-input')).toHaveValue('前缀漢字轉換后缀');
  await popup.close(); await tab.close();
});
test('floating preview stays within a narrow viewport and Escape dismisses it', async () => {
  const tab = await page();
  await tab.setViewportSize({ width: 360, height: 400 });
  await selectInput(tab, '#single', 3, 7);
  await panel(tab).getByRole('button', { name: '转繁体', exact: true }).click();
  const box = await panel(tab).boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  expect(box.y + box.height).toBeLessThanOrEqual(400);
  await tab.keyboard.press('Escape');
  await expect(panel(tab)).toBeHidden();
  await tab.close();
});
test('rendered popup and conversion preview have no script errors', async () => {
  const tab = await page();
  const errors = [];
  tab.on('pageerror', (error) => errors.push(error.message));
  await selectInput(tab, '#single', 3, 7);
  await panel(tab).getByRole('button', { name: '转繁体', exact: true }).click();
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  await tab.screenshot({ path: path.join(root, 'artifacts/selection-preview.png') });
  const popup = await context.newPage();
  popup.on('pageerror', (error) => errors.push(error.message));
  await popup.setViewportSize({ width: 392, height: 640 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator('#source').fill('汉字转换，让沟通更加自然。\n头发与发展，都有自己的写法。');
  await popup.screenshot({ path: path.join(root, 'artifacts/popup.png'), fullPage: true });
  expect(errors).toEqual([]);
  await popup.close(); await tab.close();
});

test('right-click text preview stays open when the page clears its selection', async () => {
  const tab = await page();
  await worker.evaluate(async () => {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(active.id, { type: 'TEXT_SWITCH_CONVERT', direction: 'traditional', text: '汉字转换' }, { frameId: 0 });
  });
  await expect(panel(tab).getByRole('textbox')).toHaveValue('漢字轉換');
  await tab.evaluate(() => { window.getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); });
  await tab.waitForTimeout(200);
  await expect(panel(tab)).toBeVisible();
  await expect(panel(tab).getByRole('button', { name: '复制结果' })).toBeVisible();
  await tab.close();
});
test('scrolling a long conversion preview does not close it', async () => {
  const tab = await page();
  await tab.locator('#multiline').evaluate((el) => { el.value = '汉字转换\n'.repeat(40); });
  await selectInput(tab, '#multiline', 0, 200);
  await panel(tab).getByRole('button', { name: '转繁体', exact: true }).click();
  await panel(tab).getByRole('textbox').evaluate((el) => { el.scrollTop = 100; });
  await tab.waitForTimeout(200);
  await expect(panel(tab)).toBeVisible();
  await tab.close();
});
test('selecting the same text after dismissal shows the toolbar again', async () => {
  const tab = await page();
  await selectText(tab, '#article', 0, 4);
  await tab.keyboard.press('Escape');
  await expect(panel(tab)).toBeHidden();
  await tab.locator('#article').evaluate((el) => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 200, clientY: 300 }));
  });
  await expect(panel(tab)).toBeVisible();
  await tab.close();
});

test('smooth page scrolling keeps an opened conversion result available', async () => {
  const tab = await page();
  await tab.evaluate(() => { document.body.style.minHeight = '2500px'; });
  await selectText(tab, '#article', 0, 4);
  await panel(tab).getByRole('button', { name: '转繁体', exact: true }).click();
  await tab.evaluate(() => window.scrollBy({ top: 180, behavior: 'smooth' }));
  await tab.waitForTimeout(500);
  await expect(panel(tab)).toBeVisible();
  await expect(panel(tab).getByRole('textbox')).toHaveValue('漢字轉換');
  await panel(tab).getByRole('button', { name: '复制结果' }).click();
  await expect(panel(tab).getByRole('status')).toHaveText('已复制到剪贴板');
  await tab.close();
});
test('nested shadow components support selecting text and opening a conversion preview', async () => {
  const tab = await page();
  await tab.locator('#shadow-host').evaluate((host) => {
    const nested=document.createElement('div');
    nested.attachShadow({mode:'open'}).innerHTML='<p id="nested-text">汉字转换</p>';
    host.shadowRoot.append(nested);
  });
  await selectText(tab, '#nested-text');
  await panel(tab).getByRole('button', { name: '转繁体', exact: true }).click();
  await expect(panel(tab).getByRole('textbox')).toHaveValue('漢字轉換');
  await tab.evaluate(() => window.getSelection().removeAllRanges());
  await tab.waitForTimeout(200);
  await expect(panel(tab)).toBeVisible();
  await tab.close();
});
test('a shadow component can retain focus on an empty input while text is selected', async () => {
  const tab = await page();
  await tab.locator('#shadow-input').evaluate(el => {el.focus();el.setSelectionRange(0,0);});
  await selectText(tab, '#article', 0, 4);
  await panel(tab).getByRole('button', { name: '转繁体', exact: true }).click();
  await expect(panel(tab).getByRole('textbox')).toHaveValue('漢字轉換');
  await tab.close();
});
test('right-click retains the original input target when a page collapses its selection', async () => {
  const tab = await page();
  await selectInput(tab, '#single', 3, 7);
  await tab.locator('#single').evaluate(el => {
    el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,composed:true,clientX:500,clientY:350}));
    el.setSelectionRange(0,0);
  });
  await tab.waitForTimeout(160);
  await worker.evaluate(async () => {
    const [active] = await chrome.tabs.query({active:true,currentWindow:true});
    await chrome.tabs.sendMessage(active.id,{type:'TEXT_SWITCH_CONVERT',direction:'traditional',text:'汉字转换'},{frameId:0});
  });
  await expect(panel(tab).getByRole('button',{name:'替换选中文字'})).toBeVisible();
  await panel(tab).getByRole('button',{name:'替换选中文字'}).click();
  await expect(tab.locator('#single')).toHaveValue('前缀：漢字轉換，头发发展：后缀');
  await tab.close();
});
test('clipped transformed page roots do not clip the extension popover', async () => {
  const tab = await page();
  await selectText(tab, '#article', 0, 4);
  await panel(tab).getByRole('button', { name: '转繁体', exact: true }).click();
  await tab.evaluate(() => { document.documentElement.style.transform='translate(0, 0)'; document.documentElement.style.overflow='hidden'; document.documentElement.style.height='180px'; });
  await expect(panel(tab)).toBeVisible();
  expect(await panel(tab).evaluate(host=>host.matches(':popover-open'))).toBe(true);
  await panel(tab).getByRole('button',{name:'复制结果'}).click();
  await expect(panel(tab).getByRole('status')).toHaveText('已复制到剪贴板');
  await tab.close();
});
