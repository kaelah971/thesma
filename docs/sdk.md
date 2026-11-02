# Build with Thesma SDK

Slice 3 provides a small local SDK surface for external products. It is not published to npm in this slice; copy the local source or wire these intended import paths to your local package boundary.

## Browser attribution

The browser client uses only public program configuration and public attribution resolution. It never accepts an API key.

```ts
import { createThesmaBrowserClient } from "@thesma/sdk/browser";

const thesma = createThesmaBrowserClient({
  baseUrl: "https://thesma.vercel.app",
  program: "proofpilot-partner-growth",
});

const attribution = await thesma.captureAttribution();
// ATTRIBUTED | NONE | REFUSED
const current = thesma.getAttribution();
// later: thesma.clearAttribution();
```

`captureAttribution()` reads `?ref=...`, resolves the code through the public endpoint, and stores only the program id/slug, attribution id and capture timestamp in `localStorage` under `thesma:attribution:<slug>`. It does not use fingerprinting, IP inference, API keys or financial data.

For a referral link, use the bounded helper:

```ts
import { buildReferralUrl } from "@thesma/sdk/browser";

const url = buildReferralUrl({
  destination: "https://proofpilot.example/signup?source=partner",
  referralCode: "ref_<participant-code>",
});
```

Only absolute HTTP(S) destinations without credentials are accepted. Existing query parameters are preserved.

## Server outcome submission

Keep the API key in the external product backend:

```ts
import { createThesmaServerClient } from "@thesma/sdk/server";

const thesma = createThesmaServerClient({
  baseUrl: "https://thesma.vercel.app",
  apiKey: process.env.THESMA_API_KEY!,
});

const result = await thesma.submitOutcomeEvent({
  program: "proofpilot-partner-growth",
  outcome: "activated-user",
  externalEventId: "activation_001",
  externalSubjectId: "user_123",
  attributionId: attribution?.attributionId,
  occurredAt: new Date(),
  evidence: {
    userId: "user_123",
    accountCreatedAt: "2026-01-15T11:00:00Z",
    onboardingCompletedAt: "2026-01-15T11:20:00Z",
    firstMeaningfulActionAt: "2026-01-15T12:00:00Z",
  },
  idempotencyKey: "proofpilot:activation_001",
});
```

The server client calls the existing Outcome API. It sends `Authorization: Bearer ths_api_…`, `growthProgramId`, `attributionId` and the explicit `Idempotency-Key`. It never generates a new key on retry. Use the same key for the same economic event.

`submitOutcomeEvent()` returns the event and receipt plus convenience fields: `eventId`, `receiptId`, `programId`, `attributionStatus`, `verificationState`, `operatorMode` and `executionState`. The nested receipt contains the private authorized `programEvaluation` when the event is program-bound.

```ts
const status = await thesma.getOutcomeEvent(result.event.id);
const receipt = await thesma.getReceipt(result.event.id);
```

The existing deterministic error codes remain visible through `ThesmaApiError`, including `INVALID_API_KEY`, `PROGRAM_NOT_FOUND`, `INVALID_ATTRIBUTION`, `ATTRIBUTION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `REPLAY_DETECTED` and `SHADOW_EXECUTION_BLOCKED`.

## Hosted participation

Every public program has a hosted surface:

```text
https://thesma.vercel.app/g/proofpilot-partner-growth
```

It shows the bounded objective, evidence signals, reward ceiling, participation state and truthful Shadow/settlement status. `OPEN` accepts a referral-partner request or an authenticated creator request. `INVITE_ONLY` explains that an invitation is required. `CLOSED` refuses new participation. An `APPLIED` request does not receive an attribution identity until an existing project owner activates it.

After activation, the participant receives a stable `ref_…` code. The hosted success state distinguishes `ATTRIBUTED`, `VERIFIED`, `PAID` and `SETTLED`; Slice 3 does not promise payout or settlement.

## Slice 4 receipt state

For a program-bound event, `receipt.programEvaluation` is the deterministic internal pipeline result. It distinguishes:

- `VERIFIED` from reward `ELIGIBLE`;
- reward `ELIGIBLE` / `ON_HOLD` / `SETTLEMENT_READY` from `PAID`;
- settlement eligibility `READY` from execution `BLOCKED_BY_SHADOW`;
- `WOULD_BUY` verification procurement from actual spend (`0` in Shadow);
- configured budget/CAC policy from real funding and settled spend.

A safe authorized receipt may include program and participant context, frozen reward terms, hold state, settlement reason codes, operator recommendation and paid amount. Public program config and attribution endpoints still omit budget, CAC, wallet, integration, API key and private creator information.

## Security boundary

- Browser: public program and attribution endpoints only; no secret API key.
- Server: API key and Outcome API calls only from the external product backend.
- Public CORS is limited to read-only program and attribution resolution; hosted enrollment is same-origin and does not open permissive cross-origin POST access.
- Authenticated/private Outcome API routes do not receive permissive public CORS.
- Product URLs are validated as credential-free HTTP(S) URLs; production requires HTTPS.
- Shadow Mode still blocks paid procurement, payouts, capital movement, invitations and settlement.
