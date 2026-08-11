import { betterAuth } from 'better-auth'
import { anonymous, bearer } from 'better-auth/plugins'
import { passkey } from '@better-auth/passkey'
import { Kysely } from 'kysely'
import { D1Dialect } from 'kysely-d1'
import type { Logger } from './log'
import { allowlistedProvider } from './provider-revocation'

type CreateAuthOptions = {
  request?: Request
  // `default` keeps local browser/passkey flows on loopback for dev/e2e.
  // `hosted-oauth` forces the hosted auth URL so social providers see the
  // same public callback domain that is registered in their app settings.
  mode?: 'default' | 'hosted-oauth'
  log?: Logger
}

type SocialProviderConfig = {
  clientId: string
  clientSecret: string
  appBundleIdentifier?: string
}

type CreatedUserKind = 'anonymous' | 'authenticated'

function hookPath(context: { path?: unknown } | null): string | null {
  return typeof context?.path === 'string' ? context.path : null
}

function providerDescription(providerId: string): string {
  const provider = allowlistedProvider(providerId)
  return provider === 'unsupported' ? 'an unsupported provider' : `the ${provider} provider`
}

function isLoopbackOrigin(value: string | null): value is string {
  if (!value) return false
  try {
    const { hostname } = new URL(value)
    return hostname === 'localhost' || hostname === '127.0.0.1'
  } catch {
    return false
  }
}

function getConfiguredPublicOrigins(env: Env): Set<string> {
  const configuredPublicOrigins = new Set<string>()
  if (env.BETTER_AUTH_URL && !isLoopbackOrigin(env.BETTER_AUTH_URL)) {
    configuredPublicOrigins.add(env.BETTER_AUTH_URL)
  }
  if (env.TRUSTED_ORIGINS) {
    for (const origin of env.TRUSTED_ORIGINS.split(',')) {
      const trimmed = origin.trim()
      if (trimmed) configuredPublicOrigins.add(trimmed)
    }
  }
  return configuredPublicOrigins
}

function hasSecureBetterAuthCookie(request?: Request): boolean {
  const cookieHeader = request?.headers.get('cookie') || ''
  return cookieHeader.includes('__Secure-better-auth.state=')
    || cookieHeader.includes('__Secure-better-auth.session_token=')
}

export function resolveConfiguredPublicOrigin(env: Env, request?: Request): string | null {
  if (!request) return null

  const requestUrl = new URL(request.url)
  const headerOrigin = request.headers.get('origin') || null
  const refererHeader = request.headers.get('referer') || null
  const forwardedProto = request.headers.get('x-forwarded-proto') || null
  const forwardedHostHeader = request.headers.get('x-forwarded-host')
    || request.headers.get('host')
    || null
  const configuredPublicOrigins = getConfiguredPublicOrigins(env)

  const forwardedHost = forwardedHostHeader?.split(',')[0]?.trim() || null
  const publicRequestOrigin = (() => {
    if (!forwardedHost) return null
    const protocol = forwardedProto?.split(',')[0]?.trim() || requestUrl.protocol.replace(':', '') || 'https'
    return `${protocol}://${forwardedHost}`
  })()

  if (headerOrigin && !isLoopbackOrigin(headerOrigin) && configuredPublicOrigins.has(headerOrigin)) {
    return headerOrigin
  }
  if (publicRequestOrigin && !isLoopbackOrigin(publicRequestOrigin) && configuredPublicOrigins.has(publicRequestOrigin)) {
    return publicRequestOrigin
  }
  if (refererHeader) {
    try {
      const refererOrigin = new URL(refererHeader).origin
      if (!isLoopbackOrigin(refererOrigin) && configuredPublicOrigins.has(refererOrigin)) {
        return refererOrigin
      }
    } catch {
      // Ignore malformed Referer headers
    }
  }
  if (hasSecureBetterAuthCookie(request) && env.BETTER_AUTH_URL && !isLoopbackOrigin(env.BETTER_AUTH_URL)) {
    return env.BETTER_AUTH_URL
  }
  return null
}

export function normalizeAuthRequest(env: Env, request: Request): Request {
  const requestUrl = new URL(request.url)
  const configuredPublicOrigin = resolveConfiguredPublicOrigin(env, request)
  if (!configuredPublicOrigin || !isLoopbackOrigin(requestUrl.origin)) {
    return request
  }

  const rewrittenURL = new URL(requestUrl.pathname + requestUrl.search, configuredPublicOrigin)
  return new Request(rewrittenURL.toString(), request)
}

export function createAuth(env: Env, options: CreateAuthOptions = {}) {
  const createdUsers = new Map<string, CreatedUserKind>()
  const database = new Kysely({
    dialect: new D1Dialect({ database: env.DB }),
  })

  const requestUrl = options.request ? new URL(options.request.url) : null
  const requestOrigin = requestUrl?.origin || null
  const headerOrigin = options.request?.headers.get('origin') || null
  const refererHeader = options.request?.headers.get('referer') || null

  const inferredLocalAppOrigin = (() => {
    if (!requestOrigin || !requestUrl) return null
    const isWranglerApiOrigin = isLoopbackOrigin(requestOrigin) && requestUrl.port !== '5000'
    if (!isWranglerApiOrigin) return null

    if (headerOrigin && isLoopbackOrigin(headerOrigin)) {
      return headerOrigin
    }

    return `${requestUrl.protocol}//${requestUrl.hostname}:5000`
  })()

  const configuredPublicOrigins = getConfiguredPublicOrigins(env)
  const hostedAuthURL = env.BETTER_AUTH_URL && !isLoopbackOrigin(env.BETTER_AUTH_URL)
    ? env.BETTER_AUTH_URL
    : null
  const resolvedConfiguredPublicOrigin = resolveConfiguredPublicOrigin(env, options.request)

  // Single source of truth for public app origin:
  // Local loopback wins so passkey RP ID matches localhost during dev/e2e,
  // even when BETTER_AUTH_URL points at a hosted domain.
  // Hosted OAuth mode is used only by social auth routes so provider
  // redirect_uri matches the provider app configuration.
  // This split is intentional: one app needs localhost semantics for WebAuthn
  // and e2e, but a hosted public URL for GitHub/Google/Apple OAuth callbacks.
  const baseURL = options.mode === 'hosted-oauth' && hostedAuthURL
    ? hostedAuthURL
    : resolvedConfiguredPublicOrigin || inferredLocalAppOrigin || requestOrigin || env.BETTER_AUTH_URL
  if (!baseURL) throw new Error('Unable to determine a valid base URL for authentication')

  const useSecureCookies = baseURL.startsWith('https://')
  const trustedOrigins = new Set<string>([baseURL])
  if (requestOrigin) trustedOrigins.add(requestOrigin)
  if (headerOrigin && isLoopbackOrigin(headerOrigin)) trustedOrigins.add(headerOrigin)
  // Allow extra trusted origins via env (e.g. LAN dev with custom domain + TLS)
  for (const origin of configuredPublicOrigins) {
    trustedOrigins.add(origin)
  }
  // Apple Sign-In uses form_post: Apple's server POSTs to our callback with
  // Origin: https://appleid.apple.com, so we must trust it when Apple is configured.
  if (env.APPLE_CLIENT_ID) trustedOrigins.add('https://appleid.apple.com')

  const passkeyOrigin = (() => {
    // When accessing via a trusted LAN origin (e.g. custom domain with TLS),
    // use it for passkey RP ID so WebAuthn works on that domain.
    // In hosted-oauth mode we still prefer the real browser origin here when
    // present, so passkey config tracks the page the user is actually on.
    if (headerOrigin && !isLoopbackOrigin(headerOrigin) && trustedOrigins.has(headerOrigin)) {
      return headerOrigin
    }
    // Infer from Referer when Origin header is absent (e.g. GET requests)
    if (refererHeader) {
      try {
        const refererOrigin = new URL(refererHeader).origin
        if (!isLoopbackOrigin(refererOrigin) && trustedOrigins.has(refererOrigin)) {
          return refererOrigin
        }
      } catch {
        // Ignore malformed Referer headers
      }
    }
    return baseURL
  })()

  const socialProviders: Record<string, SocialProviderConfig> = {}
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    socialProviders.github = { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
  }
  if (env.APPLE_CLIENT_ID && env.APPLE_CLIENT_SECRET) {
    socialProviders.apple = {
      clientId: env.APPLE_CLIENT_ID,
      clientSecret: env.APPLE_CLIENT_SECRET,
      appBundleIdentifier: 'app.wingdex',
    }
  }
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    socialProviders.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
  }

  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL,
    trustedOrigins: Array.from(trustedOrigins),
    database: {
      db: database,
      type: 'sqlite',
    },
    advanced: {
      useSecureCookies,
    },
    ...(Object.keys(socialProviders).length > 0 ? { socialProviders } : {}),
    user: {
      deleteUser: {
        enabled: false,
      },
    },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ['github', 'apple', 'google'],
        allowDifferentEmails: true,
      },
    },
    databaseHooks: options.log ? {
      user: {
        create: {
          after: async (user) => {
            const userKind: CreatedUserKind = user.isAnonymous === true ? 'anonymous' : 'authenticated'
            createdUsers.set(user.id, userKind)
            options.log?.info('auth/account/create', {
              category: 'Application',
              resultType: 'Succeeded',
              resultDescription: userKind === 'anonymous'
                ? 'Created a temporary anonymous WingDex account for the guest session'
                : 'Created a persistent WingDex account during authentication',
            })
          },
        },
      },
      account: {
        create: {
          after: async (account) => {
            const target = createdUsers.has(account.userId) ? 'a newly created WingDex account' : 'an existing WingDex account'
            options.log?.info('auth/provider/link', {
              category: 'Application',
              resultType: 'Succeeded',
              resultDescription: `Linked ${providerDescription(account.providerId)} to ${target} during authentication`,
            })
          },
        },
      },
      session: {
        create: {
          after: async (session, context) => {
            const createdUserKind = createdUsers.get(session.userId)
            const path = hookPath(context)
            const resultDescription = createdUserKind === 'anonymous'
              ? 'Created a server session for a newly created temporary anonymous account'
              : createdUserKind === 'authenticated'
                ? 'Created a server session for a newly created persistent account'
                : path?.endsWith('/passkey/verify-authentication')
                  ? 'Created a server session after successful passkey authentication'
                  : 'Created a server session during authentication for an existing account'
            options.log?.info('auth/session/create', {
              category: 'Application',
              resultType: 'Succeeded',
              resultDescription,
            })
          },
        },
        delete: {
          after: async (_session, context) => {
            if (!hookPath(context)?.endsWith('/sign-out')) return
            options.log?.info('auth/session/delete', {
              category: 'Application',
              resultType: 'Succeeded',
              resultDescription: 'Deleted the server session during sign-out; the authentication cookie can now be cleared',
            })
          },
        },
      },
    } : undefined,
    plugins: [
      anonymous(),
      bearer(),
      passkey({
        rpName: 'WingDex',
        rpID: new URL(passkeyOrigin).hostname,
        origin: passkeyOrigin,
        // SPIKE (#271): one ceremony, no anonymous account to promote afterwards.
        // requireSession false lets registration start unauthenticated; resolveUser
        // returns a NON-PERSISTED stub purely so WebAuthn has a user handle, and
        // afterVerification is the first point at which a row is written. With
        // createSession the plugin wraps user + passkey + session in one
        // runWithTransaction, so a cancelled or failed ceremony leaves nothing behind.
        registration: {
          // Demo-first, one ceremony. requireSession false lets registration
          // start without a session, but WingDex normally has one: the app
          // bootstraps an anonymous user on load so a visitor can use the app
          // before signing up.
          //
          // That is deliberate rather than tolerated. resolveRegistrationUser
          // returns the SESSION user whenever one exists, so the passkey
          // attaches to the anonymous user that already owns the demo and real
          // data, and the id never changes. No new user, so no row migration
          // and no cascading delete of the old one.
          requireSession: false,

          // Only reached for a genuinely sessionless signup (cookies cleared,
          // or a client that never bootstrapped). The stub is not persisted;
          // afterVerification creates the durable row.
          resolveUser: async ({ name }: { name?: string }) => ({
            id: crypto.randomUUID(),
            name: name || 'WingDex birder',
          }),

          // rc.4 calls this as afterVerification({ ctx, verification, user,
          // clientData, context }). Note `context` is NOT the auth context: it
          // is the opaque caller-supplied string from ?context=, round-tripped
          // through the stored challenge. The adapter lives on ctx.context.
          afterVerification: async ({ ctx, user }: {
            ctx: {
              context: {
                session?: { user?: { id?: string } } | null
                internalAdapter: {
                  createUser: (v: Record<string, unknown>) => Promise<{ id: string }>
                  updateUser: (id: string, v: Record<string, unknown>) => Promise<unknown>
                }
              }
            }
            user: { id: string; name?: string }
          }) => {
            const name = user.name || 'WingDex birder'
            const sessionUserId = ctx.context.session?.user?.id

            // Upgrade in place. The plugin already resolved `user` to the
            // session user, so this is the anonymous account being made
            // durable: name it and clear the anonymous flag, keeping the id and
            // therefore every row that points at it. Runs inside the plugin's
            // registration transaction, so a failed ceremony rolls the flag
            // back along with the passkey and session.
            if (sessionUserId && sessionUserId === user.id) {
              await ctx.context.internalAdapter.updateUser(sessionUserId, {
                name,
                isAnonymous: false,
              })
              return { userId: sessionUserId }
            }

            // No session: nothing to upgrade, so create the durable user here.
            const created = await ctx.context.internalAdapter.createUser({
              name,
              email: `${user.id}@passkey.wingdex.app`,
              emailVerified: false,
            })
            return { userId: created.id }
          },
        },
      }),
    ],
  })
}
