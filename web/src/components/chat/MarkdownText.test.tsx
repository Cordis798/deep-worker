import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownText } from './MarkdownText.js';

describe('MarkdownText', () => {
  it('渲染普通文本和图片链接', () => {
    const html = renderToStaticMarkup(<MarkdownText text={'你好\n![图](https://example.com/a.png)'} />);
    expect(html).toContain('你好');
    expect(html).toContain('src="https://example.com/a.png"');
    expect(html).toContain('alt="图"');
  });
});
