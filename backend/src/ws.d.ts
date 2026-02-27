declare module 'ws' {
  import { EventEmitter } from 'events';

  class WebSocket extends EventEmitter {
    close(code?: number, reason?: string | Buffer): void;
    send(
      data: string | Buffer | ArrayBuffer | Buffer[],
      cb?: (err?: Error) => void,
    ): void;
  }

  class WebSocketServer extends EventEmitter {
    handleUpgrade(
      request: import('http').IncomingMessage,
      socket: import('stream').Duplex,
      head: Buffer,
      callback: (ws: WebSocket) => void,
    ): void;
    emit(event: string, ...args: unknown[]): boolean;
  }

  export { WebSocket, WebSocketServer };
  export default WebSocket;
}
