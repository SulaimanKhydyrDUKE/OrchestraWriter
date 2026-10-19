// Better Auth instance. It owns the users/sessions/accounts/verifications tables
// and serves every /api/auth/* endpoint (sign-up, sign-in, Google OAuth, sign-out,
// get-session). Sessions are HttpOnly cookies; the browser sends them automatically.
import { betterAuth } from "better-auth";
import { env } from "./config/env.js";
import { pool } from "./db/client.js";

const google = env.auth.google;
const timestamps = { createdAt: "created_at", updatedAt: "updated_at" } as const;

export const auth = betterAuth({
  appName: "OrchestraWriter",
  baseURL: env.auth.url,
  secret: env.auth.secret,
  trustedOrigins: [env.auth.url],

  // Our existing pg pool (IAM tokens on Aurora, password locally). Better Auth
  // wraps it in Kysely and issues plain SQL against the tables below.
  database: pool,

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },

  // Google is enabled only when both values are set; the UI hides the button otherwise.
  socialProviders:
    google.clientId && google.clientSecret
      ? { google: { clientId: google.clientId, clientSecret: google.clientSecret } }
      : {},

  // Table and column names follow this repo's snake_case SQL convention.
  // Better Auth's own names (emailVerified, userId, ...) stay in TypeScript;
  // these maps translate them at the SQL boundary. See sql/schema/002_auth.sql.
  user: {
    modelName: "users",
    fields: { emailVerified: "email_verified", ...timestamps },
  },
  session: {
    modelName: "sessions",
    fields: {
      userId: "user_id",
      expiresAt: "expires_at",
      ipAddress: "ip_address",
      userAgent: "user_agent",
      ...timestamps,
    },
  },
  account: {
    modelName: "accounts",
    fields: {
      userId: "user_id",
      accountId: "account_id",
      providerId: "provider_id",
      accessToken: "access_token",
      refreshToken: "refresh_token",
      idToken: "id_token",
      accessTokenExpiresAt: "access_token_expires_at",
      refreshTokenExpiresAt: "refresh_token_expires_at",
      ...timestamps,
    },
  },
  verification: {
    modelName: "verifications",
    fields: { expiresAt: "expires_at", ...timestamps },
  },

  advanced: {
    database: {
      // Postgres generates integer ids (GENERATED ALWAYS AS IDENTITY), matching
      // the rest of the schema. Better Auth still exposes ids as strings in its API.
      generateId: "serial",
    },
  },
});

export type AuthUser = typeof auth.$Infer.Session.user;
