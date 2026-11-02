# Build with Thesma

Build with Thesma is the external outcome boundary: a product defines a bounded business outcome, submits evidence, and reads the verification decision and receipt. It uses Thesma's existing audit ledger, deterministic verification vocabulary, hold semantics, value-of-information kernel and settlement boundary. An API submission never means that money was paid.

The built-in example is a **DEVELOPER QUICKSTART / SANDBOX EXAMPLE**, not a real customer integration.

## 1. Authentication

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

## 2. Register an outcome definition

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

## 3. Submit evidence

```bash
curl -X POST https://your-thesma-host/api/v1/outcomes/activated-user/events \
  -H 'Authorization: Bearer ths_api_<placeholder>' \
  -H 'Idempotency-Key: activation_001_v1' \
  -H 'Content-Type: application/json' \
  --data '{
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

The adapter validates the payload, rejects unsupported fields, normalizes timestamps, computes an evidence hash and sends the normalized signal to the deterministic policy decision. Submitted evidence is not trusted as an unconditional `VERIFIED` flag.

## 4. Idempotency and replay protection

`Idempotency-Key` is mandatory. Retrying the same project, definition and payload with the same key returns the original event and receipt. Reusing the key with another payload returns `IDEMPOTENCY_CONFLICT`.

`externalEventId` is unique within a project. Reusing it with another key, definition or integration returns `REPLAY_DETECTED`. The same event id may be used independently by another project.

## 5. Status and receipt

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

## 6. Shadow Mode

If the project owner is in `SHADOW` mode, event evaluation still occurs and the receipt records `executionState: NOT_EXECUTED` and `settlementState: SHADOW_BLOCKED` for otherwise eligible events. Ambiguous evidence may produce `procurementRecommendation: WOULD_BUY`, using the existing value-of-information kernel, but no x402 request, Circle call, payment, payout or settlement is made.

## 7. Error model and limits

Errors use the existing response envelope:

```json
{"error":{"code":"IDEMPOTENCY_CONFLICT","message":"..."}}
```

Important codes include `INVALID_API_KEY`, `INTEGRATION_REVOKED`, `OUTCOME_NOT_FOUND`, `OUTCOME_INACTIVE`, `INVALID_EVIDENCE`, `SCHEMA_VERSION_MISMATCH`, `IDEMPOTENCY_CONFLICT`, `REPLAY_DETECTED`, `PAYLOAD_TOO_LARGE`, and `RATE_LIMITED`.

Limits are intentionally small in V1: 32 schema fields, 64 KiB evidence, 128 KiB request body, bounded string fields, no executable schema keywords, and an in-process submission guard of 120 requests per integration per minute. Persisted idempotency and unique event constraints remain the economic duplicate protection.

## 8. Security notes

- Do not use email addresses as universal subject identifiers; send a stable product-owned subject id.
- Never put an API key in browser code, source control, or logs.
- Evidence is a claim until the adapter and policy decision say otherwise.
- Testnet verification procurement remains separate from production economics; this slice does not make a paid x402 call.
- No production migration is applied automatically. The new migration must be reviewed and applied through the existing deployment process.

## Known limitations

V1 supports campaign-independent external outcome records and receipts, but does not invent a new payout executor. A future settlement adapter can connect an eligible receipt to an existing funded campaign or approved payout authority without changing the evidence or decision ledger. No webhook delivery, OAuth marketplace, arbitrary custom workflow, or real external customer integration is claimed.
