import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, getErrorMessage } from '../api/client.js';

type Mode = 'providers' | 'channels';

interface ProviderItem {
  id: string;
  name: string;
  provider: string;
  model_id: string;
  base_url: string | null;
  enabled: boolean;
  weight: number;
  has_secret: boolean;
}

interface ChannelItem {
  id: string;
  provider: string;
  name: string;
  enabled: boolean;
  is_default: boolean;
  status: string;
  has_secret: boolean;
}

const channelProviders = [
  ['feishu', '飞书'],
  ['telegram', 'Telegram'],
  ['qq', 'QQ'],
  ['dingtalk', '钉钉'],
  ['wechat', '微信'],
  ['discord', 'Discord'],
  ['whatsapp', 'WhatsApp'],
] as const;

export function IntegrationSetupPage({ mode }: { mode: Mode }) {
  const isProvider = mode === 'providers';
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [providerForm, setProviderForm] = useState({
    name: '',
    provider: 'openai',
    model_id: '',
    base_url: '',
    api_key: '',
    weight: '1',
  });
  const [channelForm, setChannelForm] = useState({ provider: 'telegram', name: '', token: '' });

  async function load() {
    setLoading(true);
    try {
      if (isProvider) {
        const data = await api.get<{ providers: ProviderItem[] }>('/api/providers');
        setProviders(data.providers);
      } else {
        const data = await api.get<{ channel_accounts: ChannelItem[] }>(
          '/api/channel-accounts',
        );
        setChannels(data.channel_accounts);
      }
      setError(null);
    } catch (reason) {
      setError(getErrorMessage(reason, '加载配置失败'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [isProvider]);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      if (isProvider) {
        await api.post('/api/providers', {
          name: providerForm.name,
          provider: providerForm.provider,
          model_id: providerForm.model_id,
          base_url: providerForm.base_url || null,
          credentials: providerForm.api_key ? { apiKey: providerForm.api_key } : undefined,
          weight: Number(providerForm.weight),
        });
        setProviderForm({
          name: '',
          provider: 'openai',
          model_id: '',
          base_url: '',
          api_key: '',
          weight: '1',
        });
      } else {
        await api.post('/api/channel-accounts', {
          provider: channelForm.provider,
          name: channelForm.name,
          credentials: channelForm.token ? { token: channelForm.token } : undefined,
        });
        setChannelForm({ ...channelForm, name: '', token: '' });
      }
      setNotice('配置已保存，凭据只会以脱敏状态展示。');
      await load();
    } catch (reason) {
      setError(getErrorMessage(reason, '保存配置失败'));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm('确定删除这条配置吗？')) return;
    try {
      await api.delete(
        `${isProvider ? '/api/providers' : '/api/channel-accounts'}/${encodeURIComponent(id)}`,
      );
      await load();
    } catch (reason) {
      setError(getErrorMessage(reason, '删除配置失败'));
    }
  }

  async function toggleProvider(item: ProviderItem) {
    try {
      await api.patch(`/api/providers/${encodeURIComponent(item.id)}`, {
        enabled: !item.enabled,
      });
      await load();
    } catch (reason) {
      setError(getErrorMessage(reason, '更新配置失败'));
    }
  }

  async function toggleChannel(item: ChannelItem) {
    try {
      await api.patch(`/api/channel-accounts/${encodeURIComponent(item.id)}`, {
        enabled: !item.enabled,
      });
      await load();
    } catch (reason) {
      setError(getErrorMessage(reason, '更新配置失败'));
    }
  }

  return (
    <section className="mx-auto w-full max-w-6xl space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">
            Deep Worker 集成
          </div>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight">
            {isProvider ? '配置 Provider' : '配置渠道账号'}
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            {isProvider
              ? '为 Pi Runner 配置模型、接入地址和故障转移候选。'
              : '保存渠道账号，后续可挂载到 Workspace 接收消息。'}
          </p>
        </div>
        <Link
          to="/chat"
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm hover:bg-slate-50"
        >
          返回工作台
        </Link>
      </div>
      {error && (
        <div role="alert" className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700"
        >
          {notice}
        </div>
      )}
      <form
        onSubmit={save}
        className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-4"
      >
        {isProvider ? (
          <>
            <Field
              label="显示名称"
              value={providerForm.name}
              onChange={(value) => setProviderForm({ ...providerForm, name: value })}
              placeholder="主模型"
              required
            />
            <Field
              label="Provider 标识"
              value={providerForm.provider}
              onChange={(value) => setProviderForm({ ...providerForm, provider: value })}
              placeholder="openai"
              required
            />
            <Field
              label="模型标识"
              value={providerForm.model_id}
              onChange={(value) => setProviderForm({ ...providerForm, model_id: value })}
              placeholder="gpt-4o-mini"
              required
            />
            <Field
              label="权重"
              type="number"
              value={providerForm.weight}
              onChange={(value) => setProviderForm({ ...providerForm, weight: value })}
              min="1"
              max="100"
              required
            />
            <Field
              label="兼容接口地址（可选）"
              value={providerForm.base_url}
              onChange={(value) => setProviderForm({ ...providerForm, base_url: value })}
              placeholder="https://api.openai.com/v1"
            />
            <Field
              label="API Key（可选）"
              type="password"
              value={providerForm.api_key}
              onChange={(value) => setProviderForm({ ...providerForm, api_key: value })}
              autoComplete="new-password"
            />
          </>
        ) : (
          <>
            <label className="text-xs text-slate-500">
              渠道类型
              <select
                value={channelForm.provider}
                onChange={(event) =>
                  setChannelForm({ ...channelForm, provider: event.target.value })
                }
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm"
              >
                <option value="">请选择渠道</option>
                {channelProviders.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <Field
              label="账号名称"
              value={channelForm.name}
              onChange={(value) => setChannelForm({ ...channelForm, name: value })}
              placeholder="团队机器人"
              required
            />
            <Field
              label="Token（可选）"
              type="password"
              value={channelForm.token}
              onChange={(value) => setChannelForm({ ...channelForm, token: value })}
              autoComplete="new-password"
            />
          </>
        )}
        <div className="flex items-end">
          <button
            disabled={saving}
            className="w-full rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存配置'}
          </button>
        </div>
      </form>
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-5 py-4 font-semibold">已保存配置</div>
        {loading ? (
          <div className="p-8 text-sm text-slate-400">加载中…</div>
        ) : isProvider ? (
          <div className="divide-y divide-slate-100">
            {providers.map((item) => (
              <ProviderRow
                key={item.id}
                item={item}
                onToggle={() => void toggleProvider(item)}
                onRemove={() => void remove(item.id)}
              />
            ))}
            {!providers.length && <Empty text="尚未配置 Provider。" />}
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {channels.map((item) => (
              <ChannelRow
                key={item.id}
                item={item}
                onToggle={() => void toggleChannel(item)}
                onRemove={() => void remove(item.id)}
              />
            ))}
            {!channels.length && <Empty text="尚未配置渠道账号。" />}
          </div>
        )}
      </div>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  required,
  autoComplete,
  min,
  max,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  required?: boolean;
  autoComplete?: string;
  min?: string;
  max?: string;
}) {
  return (
    <label className="text-xs text-slate-500">
      {label}
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
        autoComplete={autoComplete}
        min={min}
        max={max}
        className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-indigo-500"
      />
    </label>
  );
}

function ProviderRow({
  item,
  onToggle,
  onRemove,
}: {
  item: ProviderItem;
  onToggle: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
      <div>
        <div className="flex flex-wrap items-center gap-2 font-medium">
          <span>{item.name}</span>
          <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700">
            {item.provider}
          </span>
          <span
            className={
              item.enabled
                ? 'rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700'
                : 'rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500'
            }
          >
            {item.enabled ? '已启用' : '已停用'}
          </span>
        </div>
        <p className="mt-1 text-xs text-slate-400">
          模型：{item.model_id} · 权重：{item.weight} · 凭据：
          {item.has_secret ? '已保存' : '未设置'}
        </p>
      </div>
      <Actions onToggle={onToggle} onRemove={onRemove} enabled={item.enabled} />
    </div>
  );
}

function ChannelRow({
  item,
  onToggle,
  onRemove,
}: {
  item: ChannelItem;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const label =
    channelProviders.find(([value]) => value === item.provider)?.[1] ?? item.provider;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
      <div>
        <div className="flex flex-wrap items-center gap-2 font-medium">
          <span>{item.name}</span>
          <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700">
            {label}
          </span>
          <span
            className={
              item.enabled
                ? 'rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700'
                : 'rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500'
            }
          >
            {item.enabled ? '已启用' : '已停用'}
          </span>
          {item.is_default && (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
              默认
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-slate-400">
          状态：{item.status} · 凭据：{item.has_secret ? '已保存' : '未设置'}
        </p>
      </div>
      <Actions onToggle={onToggle} onRemove={onRemove} enabled={item.enabled} />
    </div>
  );
}

function Actions({
  onToggle,
  onRemove,
  enabled,
}: {
  onToggle: () => void;
  onRemove: () => void;
  enabled: boolean;
}) {
  return (
    <div className="flex gap-2">
      <button
        onClick={onToggle}
        className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs hover:bg-slate-50"
      >
        {enabled ? '停用' : '启用'}
      </button>
      <button
        onClick={onRemove}
        className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs text-rose-600 hover:bg-rose-50"
      >
        删除
      </button>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="p-10 text-center text-sm text-slate-400">{text}</div>;
}
