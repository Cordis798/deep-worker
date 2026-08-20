import { StringDecoder } from 'node:string_decoder';

/** Serialize one protocol record. Pi RPC uses LF-only framing. */
export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * Incremental LF-only decoder. U+2028/U+2029 are valid JSON string content and
 * must not be treated as record separators.
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
