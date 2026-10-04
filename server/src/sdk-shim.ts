// Local replacement for "@hatch/space-sdk" (server side).
//
// The original Stragis actions were written against the Hatch space SDK:
//   import { defineAction, z, type ActionsModule } from "@hatch/space-sdk"
//
// This shim provides the exact surface actions.ts uses, backed only by
// standard open-source packages:
//   - defineAction: identity wrapper that keeps { request, response, handler }
//   - z: re-exported from the real `zod` package
//   - ActionsModule: structural type for the exported Actions object
//   - ActionContext: the ctx handlers receive ({ db, invalidateQueries })

import { z } from "zod";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

export { z };

export interface ActionContext {
  // Returns the drizzle (SQLite) database, typed against the caller's schema.
  db<TSchema extends Record<string, unknown> = Record<string, unknown>>(): BetterSQLite3Database<TSchema>;
  // In the Hatch runtime this invalidated client queries after a mutation.
  // Here the client uses React Query mutations that invalidate explicitly,
  // so the server implementation is a no-op (see server.ts).
  invalidateQueries(): void;
}

export interface ActionDefinition<Req extends z.ZodTypeAny, Res extends z.ZodTypeAny> {
  request: Req;
  response: Res;
  handler: (
    ctx: ActionContext,
    args: z.infer<Req>,
  ) => Promise<z.infer<Res>> | z.infer<Res>;
}

export function defineAction<Req extends z.ZodTypeAny, Res extends z.ZodTypeAny>(
  def: ActionDefinition<Req, Res>,
): ActionDefinition<Req, Res> {
  return def;
}

export type ActionsModule = Record<
  string,
  ActionDefinition<z.ZodTypeAny, z.ZodTypeAny>
>;
