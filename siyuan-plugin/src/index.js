import { Plugin, Dialog, Setting, showMessage, confirm, getFrontend } from 'siyuan';
import { assetConverter } from './assets.js';
import { BLOCK_ID, decryptVault, encryptVault, importNotes, loadNotes } from './core.js';
import './index.css';

const SETTINGS = 'settings.json';

export default class PastePawWebdav extends Plugin {
  async onload() {
    if (window.siyuan?.config?.readonly || window.siyuan?.isPublish) return;
    if (!globalThis.crypto?.subtle || !globalThis.crypto.randomUUID) {
      showMessage('当前环境没有安全加密接口，请更新思源及系统 WebView', 6000, 'error');
      return;
    }
    this.layoutReady = false;
    this.session = null;
    this.controller = null;
    this.busy = false;
    this.dialog = null;
    this.sessionGeneration = 0;
    let device = localStorage.getItem('pastepaw-webdav-device');
    if (!device) {
      device = crypto.randomUUID();
      localStorage.setItem('pastepaw-webdav-device', device);
    }
    if (!/^[a-f0-9-]{36}$/i.test(device)) throw new Error('设备配置标识损坏');
    this.vaultName = `webdav-${device}.vault.json`;
    this.settings = { documentId: '', lockMinutes: 30 };
    try {
      const stored = await this.readStorage(SETTINGS);
      if (stored) this.settings = { ...this.settings, ...stored };
    } catch {
      showMessage('PastePaw：读取插件设置失败，请检查思源存储权限', 6000, 'error');
    }
    this.addIcons(
      '<symbol id="iconPastePawWebdav" viewBox="0 0 24 24"><path d="M5 4h10v4h4v12H5zM15 4l4 4M9 12h6M9 16h6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M2 11v6l-2-2m2 2 2-2" fill="none" stroke="currentColor" stroke-width="1.5"/></symbol>'
    );
    this.topBarOptions = {
      id: 'pastepaw-sync',
      icon: 'iconPastePawWebdav',
      title: '同步 PastePaw 便签',
      callback: () => this.openDialog(),
    };
    if (this.layoutReady) this.addTopBar(this.topBarOptions);
    this.addCommand({ langKey: 'syncNotes', callback: () => this.openDialog() });
    this.setting = new Setting({ confirmCallback: () => {} });
    this.timer = setInterval(() => {
      if (this.session && Date.now() >= this.session.expires) this.lock();
    }, 5000);
  }

  onLayoutReady() {
    this.layoutReady = true;
    if (this.topBarOptions) this.addTopBar(this.topBarOptions);
  }

  openSetting() {
    this.openDialog();
  }
  onunload() {
    clearInterval(this.timer);
    this.lock();
    this.dialog?.destroy();
    this.dialog = null;
  }

  lock() {
    this.sessionGeneration++;
    this.controller?.abort();
    this.controller = null;
    this.session = null;
    if (this.dialog) {
      const status = this.dialog.element.querySelector('[data-status]');
      if (status) status.textContent = '已锁定';
    }
  }

  async api(path, data, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 25000);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: data instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
        body: data instanceof FormData ? data : JSON.stringify(data),
        signal: controller.signal,
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error('思源接口请求失败，请检查登录状态和网络');
      const result = await response.json();
      if (result.code !== 0)
        throw new Error(
          path === '/api/network/forwardProxy'
            ? 'WebDAV 请求失败，请检查地址、网络、访问权限；HTTPS 连接还需检查证书'
            : '思源操作失败，请检查文档和存储权限'
        );
      return result.data;
    } catch (error) {
      // 不输出原始响应、请求参数或网络错误，避免暴露连接地址和认证信息。
      if (error?.name === 'AbortError')
        throw new Error(signal?.aborted ? '操作已取消' : '请求超时，请稍后重试');
      if (error instanceof TypeError || error instanceof SyntaxError)
        throw new Error('思源请求失败或响应格式异常');
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  storagePath(name) {
    return `/data/storage/petal/${this.name}/${name}`;
  }
  async readStorage(name) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/file/getFile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: this.storagePath(name) }),
        credentials: 'same-origin',
        signal: controller.signal,
      });
      if (response.status === 202) {
        const error = await response.json();
        if (error.code === 404) return null;
        throw new Error('无法读取插件配置');
      }
      if (!response.ok) throw new Error('无法读取插件配置');
      const text = await response.text();
      if (text.length > 65536) throw new Error('插件配置过大');
      return JSON.parse(text);
    } catch {
      throw new Error('读取插件配置失败、格式错误或超时');
    } finally {
      clearTimeout(timer);
    }
  }
  async writeStorage(name, value) {
    const form = new FormData();
    form.append('path', this.storagePath(name));
    form.append('isDir', 'false');
    form.append('file', new Blob([JSON.stringify(value)], { type: 'application/json' }), name);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/file/putFile', {
        method: 'POST',
        body: form,
        credentials: 'same-origin',
        signal: controller.signal,
      });
      if (!response.ok || (await response.json()).code !== 0) throw new Error('插件配置保存失败');
    } catch {
      throw new Error('插件配置保存失败或超时');
    } finally {
      clearTimeout(timeout);
    }
  }

  async openDialog() {
    if (this.dialog) {
      this.dialog.element.querySelector('[data-document]')?.focus();
      return;
    }
    const mobile = getFrontend() === 'mobile';
    const dialog = new Dialog({
      title: 'PastePaw · WebDAV 便签同步',
      width: mobile ? '92vw' : '620px',
      content: `<div class="b3-dialog__content pastepaw-sync">
        <div class="pastepaw-sync__status" data-status>正在读取此设备的配置…</div>
        <label>目标文档 ID<input class="b3-text-field" data-document placeholder="20261013120000-abcdefg"></label>
        <p>从文档菜单复制文档 ID，也可粘贴思源文档链接。导入会管理各便签的独立区域，保留你的其他内容。</p>
        <label>解锁有效期（5–240 分钟）<input class="b3-text-field" data-minutes type="number" min="5" max="240"></label>
        <p>配置连接前，请在 PastePaw 设置中暂停剪切板采集或退出程序，避免复制凭据时进入历史。</p>
        <details data-config><summary>配置或更换此设备的 WebDAV 连接</summary>
          <label>WebDAV 基础地址（HTTP / HTTPS）<input class="b3-text-field" data-endpoint type="url" autocomplete="off" placeholder="https://你的服务器/dav/"></label>
          <label>专用目录<input class="b3-text-field" data-directory value="pastepaw" autocomplete="off"></label>
          <label>只读用户名<input class="b3-text-field" data-username autocomplete="off"></label>
          <label>WebDAV 密码<input class="b3-text-field" data-password type="password" autocomplete="off"></label>
          <label>独立解锁密码（至少 6 字符）<input class="b3-text-field" data-new-unlock type="password" autocomplete="off"></label>
          <label>再次输入解锁密码<input class="b3-text-field" data-confirm-unlock type="password" autocomplete="off"></label>
          <button class="b3-button b3-button--outline" data-save>加密保存并解锁</button>
        </details>
        <label>独立解锁密码<input class="b3-text-field" data-unlock type="password" autocomplete="off"></label>
        <div class="pastepaw-sync__actions"><button class="b3-button b3-button--outline" data-unlock-button>解锁</button><button class="b3-button" data-sync>立即拉取便签</button><button class="b3-button b3-button--outline" data-lock>锁定 / 取消</button><button class="b3-button b3-button--outline" data-forget>清除此设备凭据</button></div>
        <p>来源删除时保留思源内容并标记；你修改过的区域会跳过并提示冲突。同一文档请等思源跨端同步完成后再从另一端导入。</p>
        <p data-storage></p><div class="pastepaw-sync__result" data-result role="status"></div>
      </div>`,
      destroyCallback: () => {
        this.controller?.abort();
        this.controller = null;
        this.dialog = null;
      },
    });
    this.dialog = dialog;
    const root = dialog.element;
    const field = (name) => root.querySelector(`[data-${name}]`);
    const value = (name) => field(name).value;
    const clear = () => {
      for (const name of [
        'endpoint',
        'username',
        'password',
        'new-unlock',
        'confirm-unlock',
        'unlock',
      ])
        field(name).value = '';
    };
    const status = () => {
      field('status').textContent = this.session
        ? '已解锁 · 仅手动拉取便签'
        : '已锁定 · 连接地址和账号密码不会回显';
    };
    field('document').value = this.settings.documentId;
    field('minutes').value = this.settings.lockMinutes;
    field('storage').textContent =
      '此设备密文位置：思源工作空间' + this.storagePath(this.vaultName);
    const act = async (action) => {
      if (this.busy) return;
      this.busy = true;
      root.querySelectorAll('button:not([data-lock])').forEach((button) => {
        button.disabled = true;
      });
      try {
        await action(this.sessionGeneration);
        status();
      } catch (error) {
        const message = error instanceof Error ? error.message : '操作失败';
        field('result').textContent = message;
        showMessage(message, 6000, 'error');
      } finally {
        this.busy = false;
        root.querySelectorAll('button').forEach((button) => {
          button.disabled = false;
        });
      }
    };
    const saveSettings = async () => {
      const match = value('document')
        .trim()
        .match(/(?:^|siyuan:\/\/blocks\/)(\d{14}-[a-z0-9]{7})(?:$|[/?#])/);
      const documentId = match?.[1];
      const lockMinutes = Number(value('minutes'));
      if (
        !BLOCK_ID.test(documentId || '') ||
        !Number.isInteger(lockMinutes) ||
        lockMinutes < 5 ||
        lockMinutes > 240
      )
        throw new Error('请填写有效文档 ID 和解锁有效期');
      this.settings = { documentId, lockMinutes };
      await this.writeStorage(SETTINGS, this.settings);
    };
    field('save').onclick = () =>
      act(async (generation) => {
        if (value('new-unlock') !== value('confirm-unlock')) throw new Error('两次解锁密码不一致');
        const credentials = {
          endpoint: value('endpoint').trim(),
          directory: value('directory').trim(),
          username: value('username'),
          password: value('password'),
        };
        const vault = await encryptVault(credentials, value('new-unlock'));
        await saveSettings();
        await this.writeStorage(this.vaultName, vault);
        if (generation !== this.sessionGeneration) throw new Error('操作已取消，凭据仍保持锁定');
        this.session = { credentials, expires: Date.now() + this.settings.lockMinutes * 60000 };
        clear();
        field('config').open = false;
        field('result').textContent = '凭据已加密保存，可以开始拉取便签。';
      });
    field('unlock-button').onclick = () =>
      act(async (generation) => {
        const vault = await this.readStorage(this.vaultName);
        if (!vault) throw new Error('此设备尚未配置 WebDAV');
        const credentials = await decryptVault(vault, value('unlock'));
        if (generation !== this.sessionGeneration) throw new Error('操作已取消，凭据仍保持锁定');
        this.session = { credentials, expires: Date.now() + this.settings.lockMinutes * 60000 };
        clear();
        field('result').textContent = '凭据已解锁。';
      });
    field('sync').onclick = () =>
      act(async (generation) => {
        if (!this.session || Date.now() >= this.session.expires) {
          this.lock();
          throw new Error('请先解锁凭据');
        }
        await saveSettings();
        if (!this.session || generation !== this.sessionGeneration) throw new Error('操作已取消');
        this.controller = new AbortController();
        const signal = this.controller.signal;
        const api = (path, data, requestSignal) => this.api(path, data, requestSignal);
        field('result').textContent = '正在从 WebDAV 拉取便签…';
        const document = await loadNotes(this.session.credentials, api, signal);
        const result = await importNotes(
          document,
          this.settings.documentId,
          api,
          assetConverter(document, this.session.credentials, api, signal),
          signal,
          (done, total) => {
            field('result').textContent = `正在导入 ${done} / ${total}`;
          }
        );
        this.controller = null;
        const message = `新增 ${result.added} · 更新 ${result.updated} · 跳过 ${result.skipped} · 来源删除 ${result.archived} · 冲突 ${result.conflicts}`;
        field('result').textContent = message;
        showMessage(message, 6000);
      });
    field('lock').onclick = () => {
      this.lock();
      clear();
      status();
    };
    field('forget').onclick = () =>
      confirm(
        '清除此设备凭据',
        '会锁定并删除此设备的密文配置。思源文档内容和其他设备配置仍保留。',
        () =>
          act(async () => {
            this.lock();
            await this.api('/api/file/removeFile', { path: this.storagePath(this.vaultName) });
            clear();
            field('config').open = true;
            field('result').textContent = '此设备凭据已清除。';
          })
      );
    try {
      const vault = await this.readStorage(this.vaultName);
      field('config').open = !vault;
      status();
    } catch {
      field('result').textContent = '无法读取此设备配置，请检查存储权限。';
      status();
    }
  }
}
