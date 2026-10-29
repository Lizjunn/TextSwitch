const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const context = { OpenCC: require('opencc-js') };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, 'extension/shared.js'), 'utf8'), context);
const { convert, settings, hasChinese } = context.TextSwitch;

test('phrase conversion distinguishes hair, development and dry/toast', () => {
  assert.equal(convert('头发发展，后台干杯，汉字转换。', 'traditional'), '頭髮發展，後臺乾杯，漢字轉換。');
});
test('mixed Chinese converges in either direction', () => {
  const input = '繁體中文和简体中文。';
  assert.equal(convert(input, 'simplified'), '繁体中文和简体中文。');
  assert.equal(convert(input, 'traditional'), '繁體中文和簡體中文。');
});
test('whitespace, punctuation, Latin text and emoji remain intact', () => {
  assert.equal(convert('  汉字\nHello, 123! 😀\t', 'traditional'), '  漢字\nHello, 123! 😀\t');
  assert.equal(convert('', 'simplified'), '');
});
test('Taiwan and Hong Kong output forms are selectable', () => {
  assert.equal(convert('里面', 'traditional', 'tw'), '裡面');
  assert.equal(convert('里面', 'traditional', 'hk'), '裏面');
});
test('unsupported conversion direction fails instead of silently changing text', () => {
  assert.throws(() => convert('文字', 'invalid'));
  assert.throws(() => convert(null, 'simplified'));
});
test('corrupted stored preferences safely use defaults', () => {
  assert.equal(settings({ traditionalVariant: 'javascript:', floatingEnabled: 'yes' }).traditionalVariant, 't');
  assert.equal(settings({ floatingEnabled: false }).floatingEnabled, false);
  assert.equal(hasChinese('😀 Hello'), false);
  assert.equal(hasChinese('😀 汉'), true);
});
test('loadable package includes every referenced file and its dictionary licenses', () => {
  const base = path.join(root, 'extension');
  const manifest = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json')));
  assert.equal(manifest.manifest_version, 3);
  const files = [manifest.background.service_worker, manifest.action.default_popup,
    ...manifest.content_scripts.flatMap((item) => item.js), ...Object.values(manifest.icons),
    'vendor/LICENSE-opencc-js.txt', 'vendor/LICENSE-opencc-data.txt', 'vendor/THIRD_PARTY_LICENSES.md'];
  for (const file of files) assert.ok(fs.statSync(path.join(base, file)).size > 0, file);
  assert.equal(manifest.content_security_policy.extension_pages.includes('unsafe-eval'), false);
});
test('right-click commands route to the selected frame without modifying text automatically', async () => {
  const listeners = {};
  const menus = [];
  let delivery;
  const chrome = {
    runtime: { id: 'test', onInstalled: { addListener: (fn) => { listeners.install = fn; } }, onMessage: { addListener: () => {} } },
    contextMenus: { onClicked: { addListener: (fn) => { listeners.click = fn; } }, removeAll: (fn) => fn(), create: (menu) => menus.push(menu) },
    tabs: { onRemoved: { addListener: () => {} }, sendMessage: async (...args) => { delivery = args; } },
    storage: { session: { remove: async () => {} } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'extension/background.js'), 'utf8'), { chrome });
  listeners.install();
  assert.equal(menus.length,2);
  for(const menu of menus) {
    assert.ok(menu.contexts.includes('selection'));
    assert.ok(menu.contexts.includes('page'));
  }
  listeners.click({ menuItemId: 'traditional', selectionText: '汉字', frameId: 7 }, { id: 23 });
  assert.equal(delivery[0], 23);
  assert.equal(delivery[1].type, 'TEXT_SWITCH_CONVERT');
  assert.equal(delivery[1].text, '汉字');
  assert.equal(delivery[2].frameId, 7);
  listeners.click({menuItemId:'simplified',frameId:3},{id:23});
  assert.equal(delivery[1].direction,'simplified');
  assert.equal(delivery[1].text,undefined);
  assert.equal(delivery[2].frameId,3);
});

test('bulk actions accept only the extension popup and start from the main frame', async () => {
  let receive;
  const deliveries=[];
  const chrome={
    runtime:{id:'test',getURL:file=>`chrome-extension://test/${file}`,onInstalled:{addListener:()=>{}},
      onMessage:{addListener:fn=>{receive=fn}}},
    contextMenus:{onClicked:{addListener:()=>{}}},
    tabs:{onRemoved:{addListener:()=>{}},query:async()=>[{id:23}],sendMessage:async(...args)=>{
      deliveries.push(args);return {ok:true,changed:2};
    }}
  };
  vm.runInNewContext(fs.readFileSync(path.join(root,'extension/background.js'),'utf8'),{chrome});
  const message={type:'TEXT_SWITCH_BULK_CONVERT',direction:'traditional',variant:'tw'};
  assert.equal(receive(message,{id:'test',url:'https://untrusted.test/'},()=>assert.fail('Untrusted request accepted')),undefined);
  assert.equal(deliveries.length,0);
  const response=await new Promise(resolve=>{
    assert.equal(receive(message,{id:'test',url:'chrome-extension://test/popup.html'},resolve),true);
  });
  assert.equal(response.changed,2);
  assert.equal(deliveries[0][0],23);
  assert.equal(deliveries[0][1].variant,'tw');
  assert.equal(deliveries[0][2].frameId,0);
});
