export function MarkdownText({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <div className="space-y-2 whitespace-pre-wrap break-words text-sm leading-6">
      {lines.map((line, index) => {
        const image = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
        if (image) return <img key={index} src={image[2]} alt={image[1]} className="max-h-72 max-w-full rounded-xl border border-slate-200" />;
        if (line.startsWith('```')) return <div key={index} className="h-2" />;
        return <p key={index} className={line.startsWith('#') ? 'font-semibold text-slate-950' : undefined}>{line || '\u00a0'}</p>;
      })}
    </div>
  );
}
