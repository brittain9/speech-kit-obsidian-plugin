import { ProviderError } from './provider';

export const MAX_ERROR_BODY_BYTES = 8 * 1024;

export class BoundedResponseCollector {
  private readonly chunks: Uint8Array[] = [];
  private capturedBytes = 0;
  private totalBytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly captureBytes: number,
  ) {}

  append(chunk: Uint8Array): void {
    this.totalBytes += chunk.byteLength;
    if (this.totalBytes > this.maxBytes) {
      throw new ProviderError(
        `Provider response exceeded ${this.maxBytes} bytes.`,
        'invalid_response',
      );
    }
    if (this.capturedBytes >= this.captureBytes) return;
    const retained = chunk.subarray(0, this.captureBytes - this.capturedBytes);
    this.chunks.push(retained);
    this.capturedBytes += retained.byteLength;
  }

  text(): string {
    const bytes = new Uint8Array(this.capturedBytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }
}
