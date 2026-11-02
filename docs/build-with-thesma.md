# Build with Thesma

**Build with Thesma means embedded growth infrastructure.** A product team starts with a growth objective and uses Thesma underneath its own application for participant programs, attribution, outcome evidence, deterministic verification, holds, settlement eligibility, receipts and operator recommendations.

Direct Thesma runs verified-outcome growth programs in Thesma's application. Build with Thesma brings the same infrastructure into another product. The `/build` surface therefore starts with a **Growth Program**, while API keys, bounded definitions, events and receipts remain supporting infrastructure.

Slices 1 and 2 ship the project-scoped Growth Program foundation, participant enrollment and attribution identities at `/build/programs` and `/build/programs/:id`. Slice 3 adds the minimum external-product integration surface: public program config, browser attribution, a server-only Outcome API client, hosted participation and generated integration snippets. It composes an existing Thesma campaign and policy draft with a bounded external outcome definition. It does not require funding, a wallet or an integration before configuration. `SHADOW` is the default and blocks every financial or external execution side effect, including creator invitations and notifications.

The built-in ProofPilot example is a **DEVELOPER QUICKSTART / SANDBOX EXAMPLE**, not a real customer integration.

## Growth Program foundation

A Growth Program configures the objective, target, exact micro-USDC budget and CAC/reward ceilings, supported participant classes (`CREATORS` and `REFERRAL_PARTNERS`), outcome definition, product connection and operator posture. Attribution is honestly `NOT_CONFIGURED` until an active participant receives an embedded `ref_…` identity. Missing attribution remains `UNATTRIBUTED`; valid, revoked and ambiguous states are returned explicitly. A program can be `PROGRAM CONFIGURED` while remaining `NOT FUNDED`; creating it never creates a company wallet or moves money.

The existing Outcome API remains the plumbing under the program. Legacy events may remain unbound. New event submissions may include `growthProgramId` and an `attributionId` after the event's definition and integration are bound to the same project and program. Attribution is never a payment or settlement authorization.

See [`embedded-growth-programs.md`](embedded-growth-programs.md) for the product model and slice boundaries. See [`sdk.md`](sdk.md) for the short browser/server quickstart.

## 1. Public browser surface

Public program configuration is available without an API key:

```http
GET /api/v1/public/programs/proofpilot-partner-growth
```

It returns only the public objective, participant classes, bounded reward summary, evidence signals, participation mode, hosted URL and truthful Shadow settlement state. It does not return budgets, CAC ceilings, policy ids, integration ids, API keys, wallets or private creator data. Public attribution resolution is:

```http
GET /api/v1/public/programs/proofpilot-partner-growth/attribution/ref_<participant-code>
```

The browser SDK uses these endpoints and stores only a namespaced attribution id locally. Public endpoints support bounded CORS; authenticated outcome endpoints remain server-to-server.

The hosted participant surface is:

```text
https://thesma.vercel.app/g/proofpilot-partner-growth
```

`OPEN` accepts a bounded referral-partner request or an authenticated creator request. `INVITE_ONLY` explains the invitation boundary. `CLOSED` refuses new participation. Activation, not request submission, creates the attribution identity.

## 2. Authentication

Create a project integration from `/build` (or the session-authenticated `POST /api/v1/integrations` endpoint). The full key is returned once:

```http
POST /api/v1/integrations
Content-Type: application/json
Cookie: <Thesma session>

{"projectId":"<project-id>","name":"Acme Productivity"}
```

Store the returned `apiKey` immediately. It has the form `ths_api_…`; Thesma stores only a SHA-256 digest, a key id and a display prefix. Revoke it from `/build` or:

```http
DELETE /api/v1/integrations/<integration-id>
X-Thesma-Project-Id: <project-id>
Cookie: <Thesma session>
```

Machine requests use:

```http
Authorization: Bearer ths_api_<placeholder>
```

Keys are project-scoped. A revoked key cannot read definitions or submit events.

## 3. Register an outcome definition

Only the supported, bounded outcome types are accepted in V1:

- `ACTIVATED_USER`
- `PURCHASE`
- `QUALIFIED_REFERRAL`
- `SUBSCRIPTION_STARTED`

A schema is deterministic JSON data, not executable code. It is immutable by version. Create version `2` rather than changing version `1`.

```bash
curl -X POST https://your-thesma-host/api/v1/outcomes \
  -H 'Authorization: Bearer ths_api_<placeholder>' \
  -H 'Content-Type: application/json' \
  --data '{
    "slug": "activated-user",
    "name": "Activated user",
    "description": "Account created, onboarding complete, first meaningful action.",
    "outcomeType": "ACTIVATED_USER",
    "unitValueMicroUsdc": "8000000",
    "evidenceSchemaVersion": 1,
    "evidenceSchema": {
      "type": "object",
      "properties": {
        "userId": {"type":"string"},
        "accountCreatedAt": {"type":"date-time"},
        "onboardingCompletedAt": {"type":"date-time"},
        "firstMeaningfulActionAt": {"type":"date-time"}
      },
      "required": ["userId","accountCreatedAt","onboardingCompletedAt","firstMeaningfulActionAt"],
      "additionalProperties": false
    },
    "holdSeconds": 86400
  }'
```

`unitValueMicroUsdc` is an integer string (`8 USDC = 8000000` micro-USDC). V1 accepts USDC only. Each supported outcome type has minimum semantic signals; a custom arbitrary string cannot bypass verification.

Read the active definition:

```bash
curl https://your-thesma-host/api/v1/outcomes/activated-user \
  -H 'Authorization: Bearer ths_api_<placeholder>'
```

## 4. Enroll participants and resolve attribution

Participation is project-scoped. The browser management surface is `/build/programs/<program-id>`; API clients use the program routes below. Session-authenticated management requests include `projectId`. A bound machine key may manage only its own program.

```http
POST /api/v1/programs/<program-id>/participation
Content-Type: application/json
Cookie: <Thesma session>

{"projectId":"<project-id>","participationStatus":"OPEN"}
```

`OPEN` creates `APPLIED` requests without sending an invitation. `APPROVE` activates a request and creates one stable `ref_…` identity. `INVITE` is deliberately rejected with `SHADOW_EXECUTION_BLOCKED` while the program or organization is in Shadow Mode; no notification, campaign terms, referral payout, procurement or settlement is created.

```http
POST /api/v1/programs/<program-id>/participants
Content-Type: application/json
Cookie: <Thesma session>

{
  "projectId":"<project-id>",
  "participantType":"REFERRAL_PARTNER",
  "externalPartnerId":"proofpilot-partner-1",
  "displayName":"ProofPilot Alumni",
  "participationSource":"OPEN_JOIN"
}
```

For an active participant, use the returned attribution code in the host product's own URL or referral surface. Resolve it server-side:

```http
POST /api/v1/programs/<program-id>/attribution/resolve
Authorization: Bearer ths_api_<placeholder>
Content-Type: application/json

{"code":"ref_<placeholder>"}
```

The resolver is project- and program-scoped. `ACTIVE` identities resolve to a participant; revoked, inactive, cross-project and cross-program identities fail closed. The response is a readiness/identity primitive, not a new legacy referral or payout record.

## 5. Submit evidence

```bash
curl -X POST https://your-thesma-host/api/v1/outcomes/activated-user/events \
  -H 'Authorization: Bearer ths_api_<placeholder>' \
  -H 'Idempotency-Key: activation_001_v1' \
  -H 'Content-Type: application/json' \
  --data '{
    "growthProgramId": "<growth-program-id>",
    "attributionId": "ref_<placeholder>",
    "externalEventId": "activation_001",
    "externalSubjectId": "user_123",
    "occurredAt": "2026-01-15T12:00:00Z",
    "evidence": {
      "userId": "user_123",
      "accountCreatedAt": "2026-01-15T11:00:00Z",
      "onboardingCompletedAt": "2026-01-15T11:20:00Z",
      "firstMeaningfulActionAt": "2026-01-15T12:00:00Z"
    }
  }'
```

The adapter validates the payload, rejects unsupported fields, resolves the optional program-scoped attribution identity, normalizes timestamps, computes an evidence hash and sends the normalized signal to the deterministic policy decision. Submitted evidence is not trusted as an unconditional `VERIFIED` flag. A valid identity is `DIRECT_ATTRIBUTION`; no identity is `UNATTRIBUTED`; invalid/revoked identity is `INVALID_ATTRIBUTION` and refuses the event; ambiguous resolution is `AMBIGUOUS` and enters review.

## 6. Idempotency and replay protection

`Idempotency-Key` is mandatory. Retrying the same project, definition and payload with the same key returns the original event and receipt. Reusing the key with another payload returns `IDEMPOTENCY_CONFLICT`.

`externalEventId` is unique within a project. Reusing it with another key, definition or integration returns `REPLAY_DETECTED`. The same event id may be used independently by another project.

## 7. Status and receipt

```bash
curl https://your-thesma-host/api/v1/outcomes/events/<event-id> \
  -H 'Authorization: Bearer ths_api_<placeholder>'
```

The response includes the event id, external ids, schema version, verification state, hold state, settlement state, evidence hash, safe reasons and an immutable receipt. It includes a decision trail from the existing audit ledger. It does not return API secrets or raw unrelated customer data.

Lifecycle vocabulary remains explicit:

```text
SUBMITTED → REVIEW or VERIFIED
VERIFIED  → HELD or ELIGIBLE_NOT_REQUESTED
PAID      → not implied by this API
SETTLED   → only after existing settlement authority and reconciliation
```

A schema-valid activation with ordered timestamps can be `VERIFIED`; ambiguous chronology is `REVIEW`. The decision is never a payout authorization.

## 8. Shadow Mode

If the project owner is in `SHADOW` mode, event evaluation still occurs and the receipt records `executionState: NOT_EXECUTED` and `settlementState: SHADOW_BLOCKED` for otherwise eligible events. Ambiguous evidence may produce `procurementRecommendation: WOULD_BUY`, using the existing value-of-information kernel, but no x402 request, Circle call, payment, payout or settlement is made.

## 9. Error model and limits

Errors use the existing response envelope:

```json
{"error":{"code":"IDEMPOTENCY_CONFLICT","message":"..."}}
```

Important codes include `INVALID_API_KEY`, `INTEGRATION_REVOKED`, `OUTCOME_NOT_FOUND`, `OUTCOME_INACTIVE`, `INVALID_EVIDENCE`, `SCHEMA_VERSION_MISMATCH`, `IDEMPOTENCY_CONFLICT`, `REPLAY_DETECTED`, `PAYLOAD_TOO_LARGE`, and `RATE_LIMITED`.

Limits are intentionally small in V1: 32 schema fields, 64 KiB evidence, 128 KiB request body, bounded string fields, no executable schema keywords, and an in-process submission guard of 120 requests per integration per minute. Persisted idempotency and unique event constraints remain the economic duplicate protection.

## 10. Security notes

- Do not use email addresses as universal subject identifiers; send a stable product-owned subject id.
- Never put an API key in browser code, source control, or logs.
- Evidence is a claim until the adapter and policy decision say otherwise.
- Testnet verification procurement remains separate from production economics; this slice does not make a paid x402 call.
- No production migration is applied automatically. The new migration must be reviewed and applied through the existing deployment process.

## Known limitations

V1 supports campaign-independent external outcome records and receipts, but does not invent a new payout executor. A future settlement adapter can connect an eligible receipt to an existing funded campaign or approved payout authority without changing the evidence or decision ledger. No webhook delivery, OAuth marketplace, arbitrary custom workflow, or real external customer integration is claimed.
