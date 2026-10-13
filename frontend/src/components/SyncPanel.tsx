import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Lock, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from './ConfirmDialog';

interface Policy {
  max_clips: number;
  clipboard_mib: number;
  image_mib: number;
  total_mib: number;
  sync_images: boolean;
}
interface Options {
  enabled: boolean;
  automatic: boolean;
  interval_seconds: number;
  lock_after_minutes: number;
  policy: Policy;
}
interface Status {
  capture_paused_until: number;
  configured: boolean;
  unlocked: boolean;
  busy: boolean;
  vault_path: string;
  options: Options;
  last_error: string | null;
  last_result: {
    notes: number;
    clips: number;
    conflicts: number;
    skipped: number;
    used_bytes: number;
    finished_at: string;
  } | null;
}

const fieldClass =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary';
const buttonClass =
  'inline-flex items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50';

export function SyncPanel() {
  const optionsDirty = useRef(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [options, setOptions] = useState<Options | null>(null);
  const [editing, setEditing] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [directory, setDirectory] = useState('pastepaw');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [unlock, setUnlock] = useState('');
  const [confirmUnlock, setConfirmUnlock] = useState('');
  const [working, setWorking] = useState(false);
  const [forget, setForget] = useState(false);

  const refresh = useCallback(async (replaceOptions = false) => {
    const next = await invoke<Status>('get_sync_status');
    setStatus(next);
    setOptions((previous) =>
      replaceOptions || !optionsDirty.current || !previous ? next.options : previous
    );
    if (replaceOptions) optionsDirty.current = false;
  }, []);

  useEffect(() => {
    refresh().catch(() => toast.error('无法读取同步设置'));
    const unlisten = listen('sync-status-changed', () => {
      refresh().catch(() => {});
    });
    const timer = setInterval(() => {
      refresh().catch(() => {});
    }, 10000);
    return () => {
      clearInterval(timer);
      void unlisten.then((stop) => stop());
    };
  }, [refresh]);

  const enteringSecrets = Boolean(status && (editing || !status.configured || !status.unlocked));
  useEffect(() => {
    const pause = () => invoke('set_sync_private_input', { active: true }).catch(() => {});
    if (enteringSecrets) void pause();
    const timer = enteringSecrets ? setInterval(pause, 30000) : null;
    return () => {
      if (timer) clearInterval(timer);
      void invoke('set_sync_private_input', { active: false }).catch(() => {});
    };
  }, [enteringSecrets]);

  const clearInputs = () => {
    setEndpoint('');
    setUsername('');
    setPassword('');
    setUnlock('');
    setConfirmUnlock('');
  };
  const act = async (action: () => Promise<unknown>, message?: string, replaceOptions = false) => {
    setWorking(true);
    try {
      const result = await action();
      if (message) toast.success(typeof result === 'string' ? result : message);
      await refresh(replaceOptions);
    } catch (error) {
      toast.error(typeof error === 'string' ? error : '操作失败，请重试');
    } finally {
      setWorking(false);
    }
  };

  if (!status || !options)
    return <p className="text-sm text-muted-foreground">正在读取同步设置…</p>;
  const busy = working || status.busy;
  const configure = editing || !status.configured;
  const changeOptions = (next: Options) => {
    optionsDirty.current = true;
    setOptions(next);
  };
  const updateNumber = (key: 'interval_seconds' | 'lock_after_minutes', value: string) =>
    changeOptions({ ...options, [key]: Number(value) });
  const updatePolicy = (key: keyof Policy, value: number | boolean) =>
    changeOptions({ ...options, policy: { ...options.policy, [key]: value } });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-medium">WebDAV 同步</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            便签全量同步，多台电脑共享受容量限制的剪切板。
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-accent px-3 py-1 text-xs">
          {status.unlocked ? '已解锁' : status.configured ? '已锁定' : '尚未配置'}
        </span>
      </div>

      {configure ? (
        <form
          className="space-y-3 rounded-lg border border-border p-4"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            if (unlock !== confirmUnlock) {
              toast.error('两次解锁密码不一致');
              return;
            }
            void act(
              async () => {
                await invoke('save_sync_options', { settings: { ...options, enabled: true } });
                await invoke('save_sync_credentials', {
                  credentials: {
                    endpoint: endpoint.trim(),
                    directory: directory.trim(),
                    username,
                    password,
                  },
                  unlockPassword: unlock,
                });
                clearInputs();
                setEditing(false);
              },
              '凭据已加密保存，请继续测试连接',
              true
            );
          }}
        >
          <label className="block space-y-1 text-sm">
            <span>WebDAV 基础地址（HTTP / HTTPS）</span>
            <input
              className={fieldClass}
              type="url"
              required
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://你的服务器/dav/"
              autoComplete="off"
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>专用目录</span>
            <input
              className={fieldClass}
              required
              pattern={'[A-Za-z0-9_\\-]{1,64}'}
              value={directory}
              onChange={(e) => setDirectory(e.target.value)}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-sm">
              <span>WebDAV 用户名</span>
              <input
                className={fieldClass}
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span>WebDAV 密码</span>
              <input
                className={fieldClass}
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span>独立解锁密码（至少 6 字符）</span>
              <input
                className={fieldClass}
                type="password"
                required
                minLength={6}
                value={unlock}
                onChange={(e) => setUnlock(e.target.value)}
                autoComplete="off"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span>再次输入解锁密码</span>
              <input
                className={fieldClass}
                type="password"
                required
                minLength={6}
                value={confirmUnlock}
                onChange={(e) => setConfirmUnlock(e.target.value)}
                autoComplete="off"
              />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            输入期间暂停剪切板采集；保存时会清除历史中匹配当前凭据的文本。解锁密码不保存，忘记后需要重新配置。
          </p>
          <div className="flex gap-2">
            <button type="submit" className={buttonClass} disabled={busy}>
              <ShieldCheck size={16} />
              保存并解锁
            </button>
            {editing && (
              <button
                type="button"
                className={buttonClass}
                onClick={() => {
                  clearInputs();
                  setEditing(false);
                }}
              >
                取消
              </button>
            )}
          </div>
        </form>
      ) : !status.unlocked ? (
        <form
          className="flex flex-wrap items-end gap-3 rounded-lg border border-border p-4"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await invoke('unlock_sync_credentials', { unlockPassword: unlock });
              setUnlock('');
            }, '凭据已解锁');
          }}
        >
          <label className="min-w-48 flex-1 space-y-1 text-sm">
            <span>独立解锁密码</span>
            <input
              className={fieldClass}
              type="password"
              required
              value={unlock}
              onChange={(e) => setUnlock(e.target.value)}
              autoComplete="off"
            />
          </label>
          <button className={buttonClass} type="submit" disabled={busy}>
            解锁
          </button>
          <button
            className={buttonClass}
            type="button"
            disabled={busy}
            onClick={() => setEditing(true)}
          >
            重新配置
          </button>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            className={buttonClass}
            disabled={busy}
            onClick={() => void act(() => invoke('test_sync_connection'), '连接测试通过')}
          >
            <ShieldCheck size={16} />
            测试连接
          </button>
          <button
            className={buttonClass}
            disabled={busy || !options.enabled}
            onClick={() => void act(() => invoke('sync_now'), '同步完成', true)}
          >
            <RefreshCw size={16} className={busy ? 'animate-spin' : ''} />
            {status.busy ? '正在同步…' : '立即同步'}
          </button>
          <button
            className={buttonClass}
            onClick={() => void act(() => invoke('lock_sync_credentials'), '已锁定')}
          >
            <Lock size={16} />
            立即锁定
          </button>
          <button className={buttonClass} disabled={busy} onClick={() => setEditing(true)}>
            重新配置
          </button>
        </div>
      )}

      <div className="space-y-4 rounded-lg border border-border p-4">
        <div className="flex flex-wrap gap-5 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={options.enabled}
              onChange={(e) => changeOptions({ ...options, enabled: e.target.checked })}
            />
            开启同步
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={options.automatic}
              onChange={(e) => changeOptions({ ...options, automatic: e.target.checked })}
            />
            解锁后自动同步
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={options.policy.sync_images}
              onChange={(e) => updatePolicy('sync_images', e.target.checked)}
            />
            同步图片
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {(
            [
              ['max_clips', '云端剪切板条数（0 为关闭）', 0, 10000],
              ['clipboard_mib', '云端剪切板额度（MiB）', 1, 10240],
              ['image_mib', '单张原图上限（MiB）', 1, 20],
              ['total_mib', '客户端云端总额度（MiB）', 10, 102400],
            ] as const
          ).map(([key, label, min, max]) => (
            <label key={key} className="space-y-1 text-sm">
              <span>{label}</span>
              <input
                className={fieldClass}
                type="number"
                min={min}
                max={max}
                value={options.policy[key]}
                onChange={(e) => updatePolicy(key, Number(e.target.value))}
              />
            </label>
          ))}
          <label className="space-y-1 text-sm">
            <span>定时同步间隔（秒）</span>
            <input
              className={fieldClass}
              type="number"
              min={30}
              max={3600}
              value={options.interval_seconds}
              onChange={(e) => updateNumber('interval_seconds', e.target.value)}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span>解锁有效期（分钟）</span>
            <input
              className={fieldClass}
              type="number"
              min={5}
              max={240}
              value={options.lock_after_minutes}
              onChange={(e) => updateNumber('lock_after_minutes', e.target.value)}
            />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          剪切板容量策略由所有设备共享，置顶和分组也计入上限。超大图片留在本机。总额度包含索引和残留原图；便签不会自动删除。服务器硬配额需要在服务端另行设置。
        </p>
        <button
          className={buttonClass}
          disabled={busy}
          onClick={() =>
            void act(
              () => invoke('save_sync_options', { settings: options }),
              '同步设置已保存',
              true
            )
          }
        >
          保存同步设置
        </button>
      </div>

      {status.last_error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 p-3 text-sm text-destructive"
        >
          {status.last_error}
        </p>
      )}
      {status.last_result && (
        <div className="space-y-1 text-sm text-muted-foreground">
          <p>最近完成：{new Date(status.last_result.finished_at).toLocaleString()}</p>
          <p>
            便签 {status.last_result.notes} 条 · 剪切板 {status.last_result.clips} 条 · 冲突{' '}
            {status.last_result.conflicts} 条 · 跳过/淘汰 {status.last_result.skipped} 条
          </p>
          <p>云端文件占用 {(status.last_result.used_bytes / 1024 / 1024).toFixed(2)} MiB</p>
        </div>
      )}
      <div className="space-y-2 border-t border-border pt-4">
        <button
          className={buttonClass}
          onClick={() =>
            void act(
              () =>
                invoke('pause_sync_clipboard', {
                  minutes: status.capture_paused_until > Date.now() ? 0 : 10,
                }),
              '采集状态已更新'
            )
          }
        >
          {status.capture_paused_until > Date.now()
            ? '恢复剪切板采集'
            : '暂停采集 10 分钟（配置思源凭据时使用）'}
        </button>
        <p className="text-xs text-muted-foreground">加密凭据保存位置：</p>
        <p className="break-all font-mono text-xs">{status.vault_path}</p>
        {status.configured && (
          <button className={buttonClass} disabled={busy} onClick={() => setForget(true)}>
            <Trash2 size={15} />
            清除本机凭据
          </button>
        )}
      </div>
      <ConfirmDialog
        isOpen={forget}
        title="清除本机凭据"
        message="将立即锁定并删除安装目录中的加密凭据。之后需要重新填写连接信息，云端和本地便签仍保留。"
        onConfirm={() => {
          setForget(false);
          void act(async () => {
            await invoke('forget_sync_credentials');
            clearInputs();
          }, '凭据已清除');
        }}
        onCancel={() => setForget(false)}
      />
    </div>
  );
}
