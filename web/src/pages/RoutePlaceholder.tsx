export function RoutePlaceholder({ title }: { title: string }) {
  return (
    <section className="mx-auto flex min-h-full w-full max-w-7xl items-center justify-center p-6 sm:p-10">
      <div className="w-full max-w-2xl rounded-3xl border border-slate-200 bg-white p-8 shadow-sm sm:p-10">
        <div className="mb-4 inline-flex rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">Deep Worker</div>
        <h2 className="text-3xl font-semibold tracking-tight">{title}</h2>
        <p className="mt-3 text-slate-500">页面路由已就绪，数据流程正在接入。</p>
      </div>
    </section>
  );
}
