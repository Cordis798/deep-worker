import { StringDecoder } from 'node:string_decoder';

/** 将一条协议记录序列化为 JSONL；Pi RPC 使用换行符作为唯一分隔符。 */
export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * 增量解析仅按换行符分帧。U+2028/U+2029 可能是 JSON 字符串内容，不能当作记录分隔符。
 */
export class JsonlDecoder {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';

  push(chunk: string | Buffer | Uint8Array): string[] {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    this.buffer += this.decoder.write(bytes);
    return this.drain(false);
  }

  end(): string[] {
    this.buffer += this.decoder.end();
    return this.drain(true);
  }

  private drain(flush: boolean): string[] {
    const lines: string[] = [];
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      lines.push(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
    if (flush && this.buffer.length > 0) {
      lines.push(this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer);
      this.buffer = '';
    }
    return lines;
  }
}
