import { build } from 'vite';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
await build({
  configFile: false,
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    minify: false,
    lib: { entry: resolve(root, 'src/index.js'), formats: ['cjs'], fileName: () => 'index.js' },
    rollupOptions: {
      external: ['siyuan'],
      output: { exports: 'default', assetFileNames: 'index.[ext]' },
    },
  },
});
const metadata = JSON.parse(await readFile(resolve(root, 'plugin.json'), 'utf8'));
if (metadata.name !== 'pastepaw-webdav-sync' || metadata.disabledInPublish !== true)
  throw new Error('插件元数据校验失败');
await mkdir(resolve(root, 'dist/i18n'), { recursive: true });
for (const name of ['plugin.json', 'README.md', 'README.zh-CN.md', 'i18n'])
  await cp(resolve(root, name), resolve(root, 'dist', name), { recursive: true });
