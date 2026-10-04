// Typed RPC client for the standalone build. Types come straight from
// `server/src/actions.ts` — no codegen.
//
// `import type { Actions }` is type-only by design: the client bundle never
// pulls in any server runtime. The proxy below turns `api.someAction(args)`
// into `POST ./actions` with JSON `{ action: "someAction", args }` and
// returns the parsed JSON response (served by server/src/server.ts).

import type { z } from "zod";
import type { Actions } from "../../server/src/actions";

type RequestOf<T> = T extends { request: infer R }
  ? R extends z.ZodTypeAny
    ? z.input<R>
    : never
  : never;

type ResponseOf<T> = T extends { handler: (...args: never[]) => infer Ret }
  ? Awaited<Ret>
  : T extends { response: infer R }
    ? R extends z.ZodTypeAny
      ? z.infer<R>
      : never
    : never;

export type ApiRequest<C, K extends keyof C> = RequestOf<C[K]>;
export type ApiResponse<C, K extends keyof C> = ResponseOf<C[K]>;

type ActionClient<T> = {
  [K in keyof T]: (args: RequestOf<T[K]>) => Promise<ResponseOf<T[K]>>;
};

function createActionClient<T>(): ActionClient<T> {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        // Promise/react machinery probes: never turn those into actions.
        if (typeof prop !== "string" || prop === "then" || prop === "catch" || prop === "finally") {
          return undefined;
        }
        return async (args: unknown) => {
          const res = await fetch("./actions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: prop, args: args ?? {} }),
          });
          const data = (await res.json().catch(() => null)) as unknown;
          if (!res.ok) {
            const message =
              data && typeof data === "object" && "error" in data
                ? String((data as { error: unknown }).error)
                : `Action ${prop} failed (HTTP ${res.status})`;
            throw new Error(message);
          }
          return data;
        };
      },
    },
  ) as ActionClient<T>;
}

export const api = createActionClient<typeof Actions>();
