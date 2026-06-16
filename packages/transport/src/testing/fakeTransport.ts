import { TransportEmitter } from '../transports/contract.js';

import type { ConnectionTarget, TransportSpec, TransportStatus } from '../core/types.js';
import type { Transport, TransportEvent, TransportEventHandler, Unsubscribe } from '../transports/contract.js';

export interface FakeTransportOptions {
  readonly spec: TransportSpec;
  readonly applyDelayMs?: number;
}

export class FakeTransport implements Transport {
  readonly spec: TransportSpec;
  readonly applyCalls: (ConnectionTarget | null)[] = [];

  private readonly emitter = new TransportEmitter();
  private readonly applyDelayMs: number;
  private currentTarget: ConnectionTarget | null = null;
  private currentStatus: TransportStatus = { up: false };
  private disposed = false;

  constructor(options: FakeTransportOptions) {
    this.spec = options.spec;
    this.applyDelayMs = options.applyDelayMs ?? 0;
  }

  async apply(target: ConnectionTarget | null): Promise<void> {
    if (this.disposed) throw new Error('disposed');
    this.applyCalls.push(target);
    if (this.applyDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.applyDelayMs));
    }
    this.currentTarget = target;
    this.currentStatus = target ? { up: true } : { up: false };
    if (target) {
      this.emitter.emit('up', undefined);
    } else {
      this.emitter.emit('down', { reason: 'detached' });
    }
  }

  health(): TransportStatus {
    return this.currentStatus;
  }

  on<E extends TransportEvent>(event: E, handler: TransportEventHandler<E>): Unsubscribe {
    return this.emitter.on(event, handler);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.emitter.clear();
  }

  emitDown(reason: string): void {
    this.currentStatus = { up: false, lastError: reason };
    this.emitter.emit('down', { reason });
  }

  emitUp(): void {
    this.currentStatus = { up: true };
    this.emitter.emit('up', undefined);
  }

  emitAuthError(status?: number): void {
    this.emitter.emit('auth-error', { status });
  }

  get target(): ConnectionTarget | null {
    return this.currentTarget;
  }
}
