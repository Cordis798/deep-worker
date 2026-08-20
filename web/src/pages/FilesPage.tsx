import { useEffect, useMemo, useState } from 'react';
import { getErrorMessage } from '../api/client.js';
import { useFileStore, encodeFilePath, type FileEntry } from '../stores/files.js';
import { useWorkspaceStore } from '../stores/workspaces.js';

export function FilesPage() {
  const workspaceId = useWorkspaceStore((state) => state.currentWorkspaceId);
  const { files, currentPath, loading, error, load, upload, createDirectory, remove, read, save } = useFileStore();
  const [directoryName, setDirectoryName] = useState('');
  const [editing, setEditing] = useState<{ path: string; content: string; image: boolean } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const root = workspaceId ? `/api/workspaces/${encodeURIComponent(workspaceId)}` : '';

  useEffect(() => { if (workspaceId) void load(workspaceId, ''); }, [workspaceId, load]);
  const breadcrumbs = useMemo(() => currentPath ? currentPath.split('/') : [], [currentPath]);

  async function openEntry(entry: FileEntry) {
    if (!workspaceId) return;
    if (entry.type === 'directory') { await load(workspaceId, entry.path); return; }
    const image = /\.(png|jpe?g|gif|webp|svg)$/i.test(entry.name);
    if (image) { setEditing({ path: entry.path, content: '', image: true }); return; }
    try { setEditing({ path: entry.path, content: await read(workspaceId, entry.path), image: false }); } catch (error) { setFileError(getErrorMessage(error, '无法读取文件')); }
  }

  async function addDirectory(event: React.FormEvent) {
    event.preventDefault();
    if (!workspaceId || !directoryName.trim()) return;
    await createDirectory(workspaceId, directoryName.trim());
    setDirectoryName('');
  }

  if (!workspaceId) return <Empty title="先选择工作区" detail="文件面板需要一个当前 Workspace。" />;
  return <section className="mx-auto w-full max-w-7xl p-4 sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">文件面板</h2><p className="mt-1 text-sm text-slate-500">当前目录：{currentPath || '/'}</p></div><label className="cursor-pointer rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700">上传文件<input type="file" multiple className="hidden" onChange={(event) => { if (event.target.files) void upload(workspaceId, event.target.files, currentPath); event.target.value = ''; }} /></label></div>
    <div className="mt-5 flex flex-wrap items-center gap-2 text-sm"><button onClick={() => void load(workspaceId, '')} className="rounded-lg px-2 py-1 text-slate-500 hover:bg-slate-100">根目录</button>{breadcrumbs.map((part, index) => <span key={`${part}-${index}`} className="flex items-center gap-2 text-slate-400"><span>/</span><button onClick={() => void load(workspaceId, breadcrumbs.slice(0, index + 1).join('/'))} className="text-slate-600 hover:text-indigo-600">{part}</button></span>)}</div>
    <form onSubmit={addDirectory} className="mt-4 flex max-w-md gap-2"><input value={directoryName} onChange={(event) => setDirectoryName(event.target.value)} placeholder="新建目录" className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500" /><button className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50">新建目录</button></form>
    {(error || fileError) && <div role="alert" className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error ?? fileError}</div>}
    <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="grid grid-cols-[minmax(0,1fr)_100px_150px_80px] gap-3 border-b border-slate-100 bg-slate-50 px-4 py-3 text-xs font-semibold text-slate-400"><span>名称</span><span>类型</span><span>修改时间</span><span /></div>{loading ? <div className="p-8 text-center text-sm text-slate-400">正在加载…</div> : files.length === 0 ? <div className="p-8 text-center text-sm text-slate-400">当前目录为空</div> : files.map((file) => <div key={file.path} className="grid grid-cols-[minmax(0,1fr)_100px_150px_80px] items-center gap-3 border-b border-slate-100 px-4 py-3 text-sm last:border-0"><button onClick={() => void openEntry(file)} className="flex min-w-0 items-center gap-3 text-left hover:text-indigo-600"><span className="grid h-8 w-8 place-items-center rounded-lg bg-slate-100">{file.type === 'directory' ? '▱' : '□'}</span><span className="truncate">{file.name}</span></button><span className="text-xs text-slate-400">{file.type === 'directory' ? '目录' : formatSize(file.size)}</span><span className="text-xs text-slate-400">{new Date(file.modifiedAt).toLocaleString()}</span><div className="flex justify-end gap-1"><a href={`${root}/files/download/${encodeFilePath(file.path)}`} className="rounded-lg px-2 py-1 text-xs text-slate-500 hover:bg-slate-100" download>下载</a>{!file.isSystem && <button onClick={() => void remove(workspaceId, file.path)} className="rounded-lg px-2 py-1 text-xs text-rose-500 hover:bg-rose-50">删除</button>}</div></div>)}</div>
    {editing && <FileEditor workspaceId={workspaceId} file={editing} onClose={() => { setEditing(null); setFileError(null); }} onSave={async (content) => { await save(workspaceId, editing.path, content); setEditing(null); }} />}
  </section>;
}

function FileEditor({ workspaceId, file, onClose, onSave }: { workspaceId: string; file: { path: string; content: string; image: boolean }; onClose: () => void; onSave: (content: string) => Promise<void> }) {
  const [content, setContent] = useState(file.content);
  const imageUrl = `/api/workspaces/${encodeURIComponent(workspaceId)}/files/download/${encodeFilePath(file.path)}`;
  return <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4" role="dialog" aria-modal="true"><div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"><div className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><h3 className="font-semibold">{file.path}</h3><button onClick={onClose} className="rounded-lg px-2 py-1 text-slate-500 hover:bg-slate-100">关闭</button></div>{file.image ? <div className="flex flex-1 items-center justify-center overflow-auto p-8"><img src={imageUrl} alt={file.path} className="max-h-[65vh] max-w-full rounded-xl" /></div> : <textarea value={content} onChange={(event) => setContent(event.target.value)} className="min-h-[55vh] flex-1 resize-none p-5 font-mono text-sm outline-none" />}{!file.image && <div className="flex justify-end gap-2 border-t border-slate-100 p-4"><button onClick={onClose} className="rounded-xl border border-slate-200 px-4 py-2 text-sm">取消</button><button onClick={() => void onSave(content)} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white">保存</button></div>}</div></div>;
}

function Empty({ title, detail }: { title: string; detail: string }) { return <section className="mx-auto w-full max-w-3xl p-6"><div className="rounded-3xl border border-slate-200 bg-white p-10 text-center"><h2 className="text-xl font-semibold">{title}</h2><p className="mt-2 text-sm text-slate-500">{detail}</p></div></section>; }
function formatSize(size: number) { if (size < 1024) return `${size} B`; if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`; return `${(size / 1024 / 1024).toFixed(1)} MB`; }
