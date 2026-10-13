import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { assetConverter } from '../src/assets.js';
import { validateNotes } from '../src/core.js';
globalThis.DOMParser = new JSDOM('').window.DOMParser;

const value = Buffer.from('附件内容');
const hash = createHash('sha256').update(value).digest('hex');
const doc = {
  schema_version: 2,
  space_id: randomUUID(),
  records: {},
  note_assets: {
    [hash]: { hash, name: '测试.txt', size: value.length, mime: 'application/octet-stream' },
  },
};
const credentials = {
  endpoint: 'http://example.invalid/webdav',
  directory: 'pastepaw',
  username: 'fixture-user',
  password: 'fixture-password',
};
test('附件经大小和 SHA256 校验后上传思源，正文链接替换并在本次导入中去重', async () => {
  let downloads = 0,
    uploads = 0;
  const convert = assetConverter(doc, credentials, async (path, data) => {
    if (path === '/api/network/forwardProxy') {
      downloads++;
      assert.equal(data.responseEncoding, 'base64');
      assert.equal(data.redirect, false);
      assert.ok(data.url.endsWith(`note-assets/${hash}.bin`));
      return { status: 200, body: value.toString('base64') };
    }
    assert.equal(path, '/api/asset/upload');
    uploads++;
    assert.ok(data instanceof FormData);
    assert.equal(await data.get('file[]').text(), value.toString());
    return {
      succFiles: [{ index: 0, path: 'assets/测试-20261013120000-abcdefg.txt' }],
      errFiles: [],
    };
  });
  const html = `<div data-type="attachment" data-asset="${hash}" data-name="测试.txt">测试.txt</div>`;
  assert.equal(
    await convert(html),
    '[测试.txt](assets/%E6%B5%8B%E8%AF%95-20261013120000-abcdefg.txt)'
  );
  await convert(html);
  assert.equal(downloads, 1);
  assert.equal(uploads, 1);
});
test('附件篡改或索引不完整时在任何思源写入之前拒绝导入', async () => {
  const convert = assetConverter(doc, credentials, async (path) => {
    assert.equal(path, '/api/network/forwardProxy');
    return { status: 200, body: Buffer.alloc(value.length).toString('base64') };
  });
  await assert.rejects(() => convert(`<img data-asset="${hash}" data-name="测试">`), /校验失败/);
  assert.throws(
    () =>
      validateNotes({
        ...doc,
        note_assets: { [hash]: { ...doc.note_assets[hash], size: 21 * 1024 * 1024 } },
      }),
    /附件/
  );
});
