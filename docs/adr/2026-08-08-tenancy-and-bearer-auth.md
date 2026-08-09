# Tenancy binds to the list, and authentication is Bearer only

Date: 2026-08-08

Status: accepted

## Context

The same status list has to be reachable several ways at once. A tenant may
front it on their own domain through a proxy, point that domain straight at the
load balancer, or let it sit on a shared service domain alongside other
tenants' lists — and whichever way a verifier arrives, the list URL baked into
issued credentials must keep resolving to the same document. So the service
needs an answer to "whose list is this?" that does not depend on how the
request arrived.

It also needs an answer to "who is calling?" on the two write operations, and
here two conventions collide. `dcc-transaction-service`, whose scaffold this
service copies, accepts both a static tenant token and HTTP Basic. VCALM's
authorization section says requests "MUST NOT utilize any authorization
protocol that includes long-lived static credentials such as usernames and
passwords", and names HTTP Basic explicitly. Meanwhile the platform is
converging on a tenant-service registry (orca-aws-hosting issue 20) that does
not exist yet, while the Certree campaign needs working tenants this week.

## Decision

**Tenancy binds to the list.** Every list row carries an immutable `tenant_id`
set at create. Authenticated writes check the caller's tenant against that row.
Ownership is never derived from the request's domain, path, or any other
request context. `GET /status-lists/{id}` stays public, per VCALM.

**Bearer only — never Basic.** A deliberate divergence from
transaction-service. Two credential forms, tried in that order:

1. an HS256 access token whose `sub` names the tenant (`ACCESS_JWT_SECRET`,
   the same variable name transaction-service uses);
2. a static tenant token, kept because one provisioning act has to work across
   transaction-service, the signing service and this one.

The OAuth `client_credentials` endpoint that would mint the first form is
**deferred** — a known, recorded conformance gap. Verification ships now, so
the endpoint is additive when a consumer needs it. No scope claim is required,
because nothing mints these tokens yet and demanding a claim whose spelling is
unsettled would reject the only tokens that can exist.

**Authentication never disables itself.** transaction-service turns tenant auth
off when no tenants are configured. Here an empty registry refuses every
authenticated request, and `TENANT_REGISTRY_MODE=memory` — which starts empty —
is refused outright when `NODE_ENV=production`.

**The registry is an async interface with an env implementation.**
`EnvTenantRegistry` reads the `TENANT_TOKEN_<NAME>` / `TENANT_ISSUER_<n>_*`
convention, so provisioning is a write to `.env` and the service exposes no
provisioning API — VCALM defines none, and long-term tenant-service owns the
write side. Structural mistakes in that env — an unknown cryptosuite, `did:web`
with no URL, half a P-256 key pair — fail the boot.

**Authorized domains narrow, they never widen.** Before serving a list the
service compares the effective host (`X-Forwarded-Host`, else `Host`) against
the owning tenant's `TENANT_DOMAINS_<NAME>` plus `PUBLIC_BASE_URL`, which is
authorized for every tenant implicitly. The same set decides whether a
client-supplied canonical `id` may be minted. There is no trust gate on the
forwarded header.

## Consequences

- One list resolves identically through a proxy, a direct domain and an ngrok
  tunnel, and moving it between them is a DNS change rather than a migration.
  The URL cutover this makes unnecessary is the whole reason canonical URLs can
  be fixed at create.
- The service is VCALM-conforming on the credential _form_ it accepts and
  short of it on the token _endpoint_. That is the honest position, and it is
  written down here rather than discovered by a conformance run.
- Static tokens remain, which VCALM would rather we did not have. They are what
  makes cross-service provisioning uniform today, and the JWT path is the exit:
  when tenant-service mints access tokens, static tokens can be dropped per
  tenant without touching this service.
- Skipping the untrusted-header debate is safe _because_ the check is not access
  control. A forged `X-Forwarded-Host` can only make the service refuse to serve
  a public document under a name — it can never surface a list to someone who
  could not already fetch it at its canonical URL. Were the GET ever
  authenticated, this reasoning would have to be redone.
- An empty registry is now a boot failure in production rather than a service
  that looks healthy and 401s every write. The cost is one more required
  variable in the deployment.
- `HttpTenantRegistry` slots in as a provider change. Nothing in the service
  reads env for tenants except the registry, and the interface has been async
  since before there was anything asynchronous behind it.
