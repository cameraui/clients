import type { ConnectionPhase } from '../core/types.js';

export interface KernelSyncMessage {
  readonly type: 'kernel-sync';
  readonly generation: number;
  readonly phase: ConnectionPhase;
  // the main thread answers kernel-resolve-request with signed server URLs
  readonly resolver?: boolean;
}

export interface KernelSyncRequestMessage {
  readonly type: 'kernel-sync-request';
}

export interface KernelRevalidateMessage {
  readonly type: 'kernel-revalidate';
}

export interface KernelResolveRequestMessage {
  readonly type: 'kernel-resolve-request';
  readonly id: number;
  readonly connId: string;
  readonly defaultServers: readonly string[];
}

export interface KernelResolveReplyMessage {
  readonly type: 'kernel-resolve-reply';
  readonly id: number;
  readonly servers?: string[];
  readonly error?: string;
}

export type WorkerMessage = KernelSyncMessage | KernelSyncRequestMessage | KernelRevalidateMessage | KernelResolveRequestMessage | KernelResolveReplyMessage;

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
