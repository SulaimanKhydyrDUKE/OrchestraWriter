// requireUser: Hono middleware that rejects requests without a valid session
// cookie and exposes the signed-in user to the handler via c.get("user").
import { createMiddleware } from "hono/factory";
import { auth, type AuthUser } from "../auth.js";

export type AuthEnv = {
  Variables: {
    user: AuthUser;
    /** users.id as a number. Better Auth hands ids over as strings. */
    userId: number;
  };
};

export const requireUser = createMiddleware<AuthEnv>(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ error: "Not signed in" }, 401);
  }
  c.set("user", session.user);
  c.set("userId", Number(session.user.id));
  await next();
});
