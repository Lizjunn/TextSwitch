import { copyFile, mkdir } from 'node:fs/promises';

const vendor = new URL('../extension/vendor/', import.meta.url);
await mkdir(vendor, { recursive: true });
await copyFile(new URL('../node_modules/opencc-js/dist/umd/full.js', import.meta.url), new URL('opencc.js', vendor));
await copyFile(new URL('../node_modules/opencc-js/LICENSE', import.meta.url), new URL('LICENSE-opencc-js.txt', vendor));
await copyFile(new URL('../node_modules/opencc-js/LICENSES/Apache-2.0.txt', import.meta.url), new URL('LICENSE-opencc-data.txt', vendor));
await copyFile(new URL('../node_modules/opencc-js/THIRD_PARTY_LICENSES.md', import.meta.url), new URL('THIRD_PARTY_LICENSES.md', vendor));
console.log('OpenCC 离线词库已准备好。');
