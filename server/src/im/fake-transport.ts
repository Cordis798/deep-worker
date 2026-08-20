import type {
  ChannelCredentials,
  ChannelTransport,
  TransportCallbacks,
  TransportInboundMessage,
  TransportTarget,
} from './channel-adapter.js';

export type FakeSentItem =
  | { kind: 'message'; target: TransportTarget; text: string }
  | { kind: 'file'; target: TransportTarget; filePath: string; fileName: string }
  | { kind: 'image'; target: TransportTarget; data: Uint8Array; mimeType: string; caption?: string; fileName?: string }
  | { kind: 'reaction'; target: TransportTarget; reaction: string };

export class FakeTransport implements ChannelTransport {
  callbacks?: TransportCallbacks;
  connected = false;
  connectCount = 0;
  sent: FakeSentItem[] = [];

  async connect(_credentials: ChannelCredentials, callbacks: TransportCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.connected = true;
    this.connectCount += 1;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  emitMessage(message: TransportInboundMessage): void {
    this.callbacks?.onMessage(message);
  }

  dropConnection(error = new Error('Fake transport disconnected')): void {
    this.connected = false;
    this.callbacks?.onDisconnect(error);
  }

  async sendMessage(target: TransportTarget, text: string): Promise<void> {
    this.ensureConnected();
    this.sent.push({ kind: 'message', target, text });
  }

  async sendFile(target: TransportTarget, filePath: string, fileName: string): Promise<void> {
    this.ensureConnected();
    this.sent.push({ kind: 'file', target, filePath, fileName });
  }

  async sendImage(target: TransportTarget, data: Uint8Array, mimeType: string, caption?: string, fileName?: string): Promise<void> {
    this.ensureConnected();
    this.sent.push({ kind: 'image', target, data, mimeType, ...(caption ? { caption } : {}), ...(fileName ? { fileName } : {}) });
  }

  async react(target: TransportTarget, reaction: string): Promise<void> {
    this.ensureConnected();
    this.sent.push({ kind: 'reaction', target, reaction });
  }

  private ensureConnected(): void {
    if (!this.connected) throw new Error('Fake transport is disconnected');
  }
}
