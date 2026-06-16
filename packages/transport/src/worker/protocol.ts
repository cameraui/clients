import type { ConnectionPhase } from '../core/types.js';

export interface KernelSyncMessage {
  readonly type: 'kernel-sync';
  readonly generation: number;
  readonly phase: ConnectionPhase;
}

export interface KernelSyncRequestMessage {
  readonly type: 'kernel-sync-request';
}

export interface KernelRevalidateMessage {
  readonly type: 'kernel-revalidate';
}

export type WorkerMessage = KernelSyncMessage | KernelSyncRequestMessage | KernelRevalidateMessage;

export interface MessageSource {
  postMessage(message: WorkerMessage): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerMessage>) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<WorkerMessage>) => void): void;
}

export interface WorkerHost {
  postMessage(message: WorkerMessage): void;
  addEventListener?(type: 'message', listener: (event: MessageEvent<WorkerMessage>) => void): void;
  removeEventListener?(type: 'message', listener: (event: MessageEvent<WorkerMessage>) => void): void;
}
