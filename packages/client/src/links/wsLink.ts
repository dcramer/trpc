import {
  AnyRouter,
  JSONRPC2RequestEnvelope,
  JSONRPC2ResponseEnvelope,
  TRPCProcedureEnvelope,
} from '@trpc/server';
import { TRPCClientError } from '../createTRPCClient';
import {
  observable,
  ObservableLike,
  observableSubject,
} from '../internals/observable';
import { TRPCLink } from './core';

export function createWebSocketClient(opts: { url: string }) {
  const { url } = opts;
  const $isOpen = observableSubject(false);
  const $messages = observable<MessageEvent>();
  const $closed = observableSubject(false);

  function createWS() {
    const $newClient = observableSubject(new WebSocket(url));
    // TODO protocols?
    const ws = $newClient.get();

    ws.addEventListener('open', () => {
      $isOpen.set(true);

      // gracefully reconnect if gotten told to do so
      $ws.set(ws);
    });
    ws.addEventListener('message', (msg) => {
      $messages.set(msg);
    });

    // FIXME handle reconnect
    // FIXME handle graceful reconnect - server restarts etc
    return ws;
  }
  const $ws = observableSubject(createWS());

  $closed.subscribe({
    onNext: (open) => {
      if (!open) {
        $ws.done();
        $isOpen.set(false);
        $isOpen.done();
        $messages.done();
      } else {
        // FIXME maybe allow re-open?
      }
    },
  });
  return {
    $ws,
    $isOpen,
    $messages,
    isClosed: () => $closed.get(),
    close: () => $closed.set(true),
  };
}
export type TRPCWebSocketClient = ReturnType<typeof createWebSocketClient>;

export interface WebSocketLinkOptions {
  client: TRPCWebSocketClient;
}
export function wsLink<TRouter extends AnyRouter>(
  opts: WebSocketLinkOptions,
): TRPCLink<TRouter> {
  // initialized config
  return (rt) => {
    let requestId = 0;
    const { client } = opts;
    type Listener = ObservableLike<TRPCProcedureEnvelope<TRouter, unknown>>;
    const listeners: Record<number, Listener> = {};

    client.$messages.subscribe({
      onNext(msg) {
        try {
          const { id, result } = rt.transformer.deserialize(
            JSON.parse(msg.data),
          ) as JSONRPC2ResponseEnvelope<
            TRPCProcedureEnvelope<TRouter, unknown>
          >;
          const listener = listeners[id];
          if (!listener) {
            // FIXME do something?
            return;
          }
          listener.set(result);
        } catch (err) {
          // FIXME do something?
        }
      },
    });

    function send(req: JSONRPC2RequestEnvelope) {
      client.$ws.get().send(JSON.stringify(rt.transformer.serialize(req)));
    }

    return ({ op, prev, onDestroy }) => {
      requestId++;
      if (listeners[requestId]) {
        // should never happen
        prev(new Error(`Duplicate requestId '${requestId}'`));
        return;
      }
      let unsub$open: null | (() => void) = null;
      let unsub$result: null | (() => void) = null;

      function exec() {
        unsub$open?.();
        const { input, type, path } = op;
        send({
          id: requestId,
          method: type,
          params: {
            input,
            path,
          },
          jsonrpc: '2.0',
        });
        const $res = (listeners[requestId] = observable());
        $res.subscribe({
          onNext(result) {
            prev(result.ok ? result : TRPCClientError.from(result));
          },
          onDone() {
            send({
              id: requestId,
              method: 'stop',
              jsonrpc: '2.0',
            });
          },
        });
        unsub$result = () => {
          listeners[requestId]?.done();
          delete listeners[requestId];
        };
      }
      if (client.$isOpen.get()) {
        exec();
      } else {
        unsub$open = client.$isOpen.subscribe({ onNext: exec });
      }
      onDestroy(() => {
        unsub$open?.();
        unsub$result?.();
      });
    };
  };
}
