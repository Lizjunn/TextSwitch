const { test, expect, chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
let context, worker, server, crossServer, base, crossBase, profile, extensionId;
const first = '前缀：汉字转换，头发发展：后缀';
const traditional = '前綴：漢字轉換，頭髮發展：後綴';
const multiline = '第一行汉字\n后台干杯 😀';

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/frame') res.end('<textarea id="frame-input">汉字转换</textarea>');
    else res.end(`<!doctype html><meta charset="utf-8"><title>批量转换体验</title>
      <style>body{font:16px sans-serif;padding:20px}input,textarea{display:block;margin:8px;min-height:28px}</style>
      <form id="form"><input id="first" value="${first}"><textarea id="area">${multiline}</textarea>
      <input id="english" value="Hello 😀 123"><input id="empty" placeholder="汉字转换"></form>
      <script>window.submitted=0;document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();window.submitted++});</script>`);
  });
  crossServer = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<input id="cross-input" value="汉字转换">');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => crossServer.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  crossBase = `http://127.0.0.1:${crossServer.address().port}`;
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'textswitch-bulk-'));
  const extension = path.join(root, 'extension');
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width: 1100, height: 850 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (crossServer) await new Promise(resolve => crossServer.close(resolve));
  if (profile && path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('textswitch-bulk-')) {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

async function page() {
  const tab = await context.newPage();
  await tab.goto(base);
  return tab;
}

async function request(tab, type = 'TEXT_SWITCH_BULK_CONVERT', direction = 'traditional', variant = 't') {
  await tab.bringToFront();
  return worker.evaluate(async message => {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    return chrome.tabs.sendMessage(active.id, message, { frameId: 0 });
  }, { type, direction, variant });
}

test('bulk conversion changes complete input values in both directions and preserves Unicode', async () => {
  const tab = await page();
  let response = await request(tab);
  expect(response).toMatchObject({ ok: true, changed: 2, skipped: 0, undoAvailable: true });
  await expect(tab.locator('#first')).toHaveValue(traditional);
  await expect(tab.locator('#area')).toHaveValue('第一行漢字\n後臺乾杯 😀');
  await expect(tab.locator('#english')).toHaveValue('Hello 😀 123');
  await expect(tab.locator('#empty')).toHaveValue('');
  response = await request(tab, 'TEXT_SWITCH_BULK_CONVERT', 'simplified');
  expect(response.changed).toBe(2);
  await expect(tab.locator('#first')).toHaveValue(first);
  await expect(tab.locator('#area')).toHaveValue(multiline);
  await tab.close();
});

test('bulk conversion excludes hidden, protected, inert and disabled-fieldset controls', async () => {
  const tab = await page();
  await tab.evaluate(() => {
    const fixture = document.createElement('div');
    fixture.innerHTML = `
      <input data-protected type="hidden" value="汉字转换">
      <input data-protected type="password" value="汉字转换">
      <input data-protected type="email" value="汉字转换@example.com">
      <input data-protected readonly value="汉字转换">
      <input data-protected disabled value="汉字转换">
      <input data-protected hidden value="汉字转换">
      <input data-protected style="display:none" value="汉字转换">
      <input data-protected style="visibility:hidden" value="汉字转换">
      <input data-protected style="opacity:0" value="汉字转换">
      <input data-protected style="width:0;height:0;min-height:0;padding:0;border:0" value="汉字转换">
      <input data-protected aria-disabled="true" value="汉字转换">
      <div hidden><input data-protected value="汉字转换"></div>
      <div style="opacity:0"><input data-protected value="汉字转换"></div>
      <div style="content-visibility:hidden"><input data-protected value="汉字转换"></div>
      <div inert><input data-protected value="汉字转换"></div>
      <div aria-hidden="true"><textarea data-protected>汉字转换</textarea></div>
      <fieldset disabled><input data-protected value="汉字转换"></fieldset>
      <details><summary>折叠内容</summary><input data-protected value="汉字转换"></details>`;
    document.body.append(fixture);
    window.protectedValues = [...document.querySelectorAll('[data-protected]')].map(el => el.value);
  });
  const result = await request(tab);
  expect(result.changed).toBe(2);
  expect(await tab.locator('[data-protected]').evaluateAll(elements => elements.map(el => el.value)))
    .toEqual(await tab.evaluate(() => window.protectedValues));
  await tab.close();
});

test('bulk conversion includes offscreen fields, preserves focus and caret, and never submits', async () => {
  const tab = await page();
  await tab.evaluate(() => {
    const field = document.createElement('input'); field.id = 'below-fold'; field.value = '汉字转换';
    field.style.marginTop = '2000px'; document.body.append(field);
    const first = document.querySelector('#first'); first.focus(); first.setSelectionRange(3, 7);
  });
  const result = await request(tab);
  expect(result.changed).toBe(3);
  await expect(tab.locator('#below-fold')).toHaveValue('漢字轉換');
  expect(await tab.evaluate(() => ({ y: scrollY, active: document.activeElement.id, submitted: window.submitted,
    selection: [document.querySelector('#first').selectionStart, document.querySelector('#first').selectionEnd] })))
    .toEqual({ y: 0, active: 'first', submitted: 0, selection: [3, 7] });
  await tab.waitForTimeout(180);
  await expect(tab.locator('#textswitch-extension')).toBeHidden();
  await tab.close();
});

test('bulk conversion traverses open and closed components and checks their hosts', async () => {
  const tab = await page();
  const closed = await tab.evaluateHandle(() => {
    const open = document.createElement('div');
    open.attachShadow({ mode: 'open' }).innerHTML = '<input id="open-input" value="汉字转换"><slot></slot>';
    const slotted = document.createElement('input'); slotted.id='slotted'; slotted.value='汉字转换'; open.append(slotted);
    const hidden = document.createElement('div'); hidden.hidden = true;
    hidden.attachShadow({ mode: 'open' }).innerHTML = '<input id="hidden-shadow-input" value="汉字转换">';
    const host = document.createElement('div'); const input=document.createElement('input'); input.value='汉字转换';
    host.attachShadow({ mode: 'closed' }).append(input);
    document.body.append(open, hidden, host); return input;
  });
  expect((await request(tab)).changed).toBe(5);
  await expect(tab.locator('#open-input')).toHaveValue('漢字轉換');
  await expect(tab.locator('#slotted')).toHaveValue('漢字轉換');
  await expect(tab.locator('#hidden-shadow-input')).toHaveValue('汉字转换');
  expect(await closed.evaluate(el => el.value)).toBe('漢字轉換');
  expect((await request(tab, 'TEXT_SWITCH_BULK_UNDO')).changed).toBe(5);
  expect(await closed.evaluate(el => el.value)).toBe('汉字转换');
  await closed.dispose(); await tab.close();
});

test('bulk conversion visits visible same-origin frames and skips hidden and cross-origin frames', async () => {
  const tab = await page();
  await tab.evaluate(crossBase => {
    const frames = document.createElement('div'); frames.innerHTML = `
      <iframe id="visible-frame" src="/frame"></iframe>
      <div hidden><iframe id="hidden-frame" src="/frame"></iframe></div>
      <iframe id="cross-frame" src="${crossBase}/"></iframe>`;
    document.body.append(frames);
  }, crossBase);
  await expect(tab.frameLocator('#visible-frame').locator('#frame-input')).toBeVisible();
  await expect(tab.frameLocator('#hidden-frame').locator('#frame-input')).toHaveValue('汉字转换');
  await expect(tab.frameLocator('#cross-frame').locator('#cross-input')).toBeVisible();
  const result = await request(tab);
  expect(result).toMatchObject({ changed: 3, inaccessibleFrames: 1 });
  await expect(tab.frameLocator('#visible-frame').locator('#frame-input')).toHaveValue('漢字轉換');
  await expect(tab.frameLocator('#hidden-frame').locator('#frame-input')).toHaveValue('汉字转换');
  await expect(tab.frameLocator('#cross-frame').locator('#cross-input')).toHaveValue('汉字转换');
  expect((await request(tab, 'TEXT_SWITCH_BULK_UNDO')).changed).toBe(3);
  await expect(tab.frameLocator('#visible-frame').locator('#frame-input')).toHaveValue('汉字转换');
  await tab.close();
});

test('batch input events update a controlled model and preserve event order', async () => {
  const tab = await page();
  await tab.locator('#first').evaluate(el => {
    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    let tracked=el.value; window.model=el.value; window.events=[];
    Object.defineProperty(el,'value',{configurable:true,get(){return native.get.call(this)},set(value){tracked=value;native.set.call(this,value)}});
    for(const type of ['beforeinput','input','change'])el.addEventListener(type,event=>{
      window.events.push({type:event.type,composed:event.composed});
      if(type==='input'&&el.value!==tracked){window.model=el.value;tracked=el.value;}
    });
  });
  await request(tab);
  expect(await tab.evaluate(() => window.model)).toBe(traditional);
  expect(await tab.evaluate(() => window.events)).toEqual([
    {type:'beforeinput',composed:true},{type:'input',composed:true},{type:'change',composed:true}
  ]);
  await request(tab, 'TEXT_SWITCH_BULK_UNDO');
  expect(await tab.evaluate(() => window.model)).toBe(first);
  await tab.close();
});

test('batch respects beforeinput cancellation and a page changing another field', async () => {
  const tab = await page();
  await tab.locator('#first').evaluate(el => el.addEventListener('beforeinput',event => event.preventDefault()));
  expect(await request(tab)).toMatchObject({ changed: 1, skipped: 1 });
  await expect(tab.locator('#first')).toHaveValue(first);
  await tab.reload();
  await tab.locator('#first').evaluate(el => el.addEventListener('beforeinput',() => { document.querySelector('#area').value='用户最新内容'; }));
  expect(await request(tab)).toMatchObject({ changed: 1, skipped: 1 });
  await expect(tab.locator('#area')).toHaveValue('用户最新内容');
  await tab.close();
});

test('batch undo never overwrites user edits, removed fields or newly protected fields', async () => {
  const tab = await page();
  await request(tab);
  await tab.locator('#first').fill('用户最新输入');
  expect(await request(tab, 'TEXT_SWITCH_BULK_UNDO')).toMatchObject({ changed: 1, skipped: 1, undoAvailable: false });
  await expect(tab.locator('#first')).toHaveValue('用户最新输入');
  await expect(tab.locator('#area')).toHaveValue(multiline);
  await tab.reload(); await request(tab);
  await tab.evaluate(() => { document.querySelector('#first').remove(); document.querySelector('#area').readOnly=true; });
  expect(await request(tab, 'TEXT_SWITCH_BULK_UNDO')).toMatchObject({ changed: 0, skipped: 2 });
  await expect(tab.locator('#area')).toHaveValue('第一行漢字\n後臺乾杯 😀');
  await tab.close();
});

test('a no-op batch preserves the last undo and uses the chosen traditional variant', async () => {
  const tab = await page();
  await tab.locator('#first').fill('里面');
  expect((await request(tab,'TEXT_SWITCH_BULK_CONVERT','traditional','tw')).changed).toBe(2);
  await expect(tab.locator('#first')).toHaveValue('裡面');
  expect(await request(tab,'TEXT_SWITCH_BULK_CONVERT','traditional','tw')).toMatchObject({changed:0,undoAvailable:true});
  expect((await request(tab,'TEXT_SWITCH_BULK_UNDO')).changed).toBe(2);
  await expect(tab.locator('#first')).toHaveValue('里面');
  await tab.close();
});

test('popup performs bulk conversion through the active tab and can reopen to undo', async () => {
  const tab = await page();
  let popup = await context.newPage(); await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await tab.bringToFront();
  await popup.evaluate(() => document.querySelector('[data-bulk-direction="traditional"]').click());
  await expect(popup.locator('#bulk-status')).toHaveText('已转换 2 个输入框。');
  await expect(tab.locator('#first')).toHaveValue(traditional);
  await popup.close();
  popup = await context.newPage(); await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await tab.bringToFront();
  // State is requested during popup initialization; explicitly reopen after bringing the tab forward.
  await popup.reload(); await tab.bringToFront();
  await expect(popup.locator('#bulk-undo')).toBeVisible();
  await popup.evaluate(() => document.querySelector('#bulk-undo').click());
  await expect(popup.locator('#bulk-status')).toHaveText('已撤销 2 个输入框。');
  await expect(tab.locator('#first')).toHaveValue(first);
  fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});
  await popup.screenshot({path:path.join(root,'artifacts/bulk-popup.png'),fullPage:true});
  await popup.close(); await tab.close();
});
