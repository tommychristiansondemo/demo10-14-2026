# Implementation Plan: ClaimClarify

## Overview

This plan implements ClaimClarify in **TypeScript** end to end: the static Chat_UI, the API Gateway + Lambda chat handler, the two MCP servers (`policy-lookup`, `repair-estimator`) for Bedrock AgentCore Runtime, and the agent orchestration/composition logic. Infrastructure is defined with **AWS CDK (TypeScript)** across `us-east-2` (app/data/compute) and `us-east-1` (ACM certificate), publishing a unique Route 53 record in `awsteach.com` without disturbing `www.awsteach.com`.

The work is sequenced to build pure, deterministic logic first (validators, estimator, composer, router, config loader, trace propagation, seed/precheck helpers) so the 17 property-based tests catch errors early, then wires that logic into Lambda handlers and MCP servers, and finally defines and verifies the CDK infrastructure with synthesis/snapshot tests. Integration and smoke tests close the loop.

Conventions used throughout:
- Property-based tests use **fast-check**, run a **minimum of 100 iterations** each, and are tagged with a comment of the form `Feature: claimclarify, Property <N>: <property text>`.
- One property-based test per correctness property (Properties 1–17).
- Pure logic is tested without AWS I/O; where a store is needed an in-memory fake is used.
- Tasks marked with `*` are optional (test tasks) and can be skipped for a faster MVP; all other tasks are implemented.

## Tasks

- [x] 1. Set up monorepo structure, shared types, and tooling
  - Create workspace layout: `packages/shared` (types + pure logic), `packages/api` (chat handler Lambda), `packages/policy-lookup` (MCP server), `packages/repair-estimator` (MCP server), `packages/ui` (static Chat_UI), `infra` (CDK app)
  - Configure TypeScript, a test runner (Vitest or Jest), and **fast-check** as a dev dependency
  - Define shared types/interfaces: `ChatRequest`, `ChatResponse`, `StructuredError` (`type: VALIDATION_ERROR | NOT_FOUND | DEPENDENCY_ERROR | TIMEOUT | CONFIG_ERROR`, optional `field`, optional `dependency`, `message`), `PolicyRecord`, `ClaimInput`, `EstimateResult`, severity set `{minor, moderate, severe, total_loss}`
  - Add npm scripts for build, lint, and test (single-run, non-watch)
  - _Requirements: 13.4, 13.5, 14.1_

- [x] 2. Implement shared input-validation logic (pure)
  - [x] 2.1 Implement message/request validators
    - Implement `validateMessageLength(input: string)` returning accept iff `1 <= length <= 2000`, else an allowed-range error payload that signals the UI to retain input text (Req 1.3)
    - Implement `validateChatRequest(body)` returning accept iff JSON shape conforms, `message` non-empty, `message` length ≤ 2000, and total payload size ≤ 1 MB; on failure produce a `VALIDATION_ERROR` naming the violated constraint/field (Req 2.3, 2.4, 13.1, 13.4)
    - _Requirements: 1.3, 2.3, 2.4, 13.1, 13.4_
  - [x] 2.2 Write property test for client-side message length validation
    - **Property 1: Client-side message length validation** — accept iff length in [1,2000]; rejected strings yield allowed-range error and retain text
    - **Validates: Requirements 1.3**
    - Use fast-check, ≥100 iterations; tag `Feature: claimclarify, Property 1: ...`
  - [x] 2.3 Write property test for API request validation gate
    - **Property 2: API request validation gate** — accept iff schema-conformant, non-empty message, ≤2000 chars, ≤1MB payload; else HTTP 400 naming the constraint and agent not invoked (assert agent-invoke spy not called)
    - **Validates: Requirements 2.3, 2.4, 13.1**
    - Request-body generator spanning valid shapes, empty/overlong messages, oversized payloads; fast-check ≥100 iterations; tag accordingly
  - [x] 2.4 Write property test for structured validation-error shape
    - **Property 14: Structured validation-error shape** — any invalid input to any validating component yields error with `type = VALIDATION_ERROR` and populated `field`
    - **Validates: Requirements 13.4**
    - Exercise message, request, policyId, and Claim_Input validators; fast-check ≥100 iterations; tag accordingly

- [x] 3. Implement repair-estimator pure logic (classification + estimation)
  - [x] 3.1 Implement `Claim_Input` schema validation
    - Validate `vehicleYear` (integer, 1980..currentYear+1), `impactLocation` ∈ {front, rear, side, roof, undercarriage}, `driveable` (boolean required), `airbagDeployed` (boolean required), `visibleDamagePanels` (integer 0..20); on failure return `VALIDATION_ERROR` naming the field and no estimate (Req 6.5, 13.3, 13.4)
    - _Requirements: 6.5, 13.3, 13.4_
  - [x] 3.2 Implement deterministic `estimateRepair(claim)` logic
    - Map validated inputs to `severity` ∈ predefined set, `estimatedCostUsd` ≥ 0, `turnaroundDays` ≥ 0; keep logic pure and deterministic (no AWS I/O)
    - _Requirements: 6.2, 6.3, 6.4_
  - [x] 3.3 Write property test for estimator well-formedness
    - **Property 9: Estimator output is well-formed for valid input** — valid Claim_Input yields severity in the predefined set, cost ≥ 0, turnaround ≥ 0
    - **Validates: Requirements 6.2, 6.3, 6.4**
    - Valid-`Claim_Input` generator incl. boundary values; fast-check ≥100 iterations; tag accordingly
  - [x] 3.4 Write property test for estimator input validation
    - **Property 10: Estimator input validation** — missing/out-of-range field yields `VALIDATION_ERROR` naming the field and no severity/cost/turnaround
    - **Validates: Requirements 6.5, 13.3**
    - Generator producing missing/out-of-range fields incl. non-ASCII; fast-check ≥100 iterations; tag accordingly

- [x] 4. Implement policy-lookup pure logic over an in-memory store
  - [x] 4.1 Implement policyId validation and store interface
    - Define `PolicyStore` interface (read-only lookups) with an in-memory fake for tests
    - Implement `validatePolicyId(id)`: present, non-empty, ≤ 64 chars; else `VALIDATION_ERROR` naming the input and store unchanged (Req 4.6, 13.2, 13.4)
    - _Requirements: 4.6, 13.2, 13.4_
  - [x] 4.2 Implement the three read-only lookup tools
    - Implement `get_coverage`, `get_deductibles`, `get_prior_claims` returning exactly the stored data for an existing policyId; for a missing id return `NOT_FOUND` naming the id with the store unchanged (Req 4.2, 4.3, 4.4, 4.5); never write or delete (Req 10.2)
    - _Requirements: 4.2, 4.3, 4.4, 4.5, 10.2_
  - [x] 4.3 Write property test for policy lookup fidelity
    - **Property 4: Policy lookup fidelity** — for any present record and any of the three tools, lookup by its policyId returns exactly the stored data
    - **Validates: Requirements 4.2, 4.3, 4.4**
    - Policy-store generator with unique ids; fast-check ≥100 iterations; tag accordingly
  - [x] 4.4 Write property test for not-found leaving store unchanged
    - **Property 5: Policy not-found leaves store unchanged** — absent policyId yields `NOT_FOUND` naming it; store contents identical before/after
    - **Validates: Requirements 4.5**
    - Snapshot store before/after and compare; fast-check ≥100 iterations; tag accordingly
  - [x] 4.5 Write property test for policy identifier validation
    - **Property 6: Policy identifier validation** — absent/empty/>64-char policyId yields `VALIDATION_ERROR` naming the invalid input; store unchanged
    - **Validates: Requirements 4.6, 13.2**
    - fast-check ≥100 iterations; tag accordingly

- [x] 5. Checkpoint — pure estimator & policy logic
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement agent response composition and dependency-error wrapping (pure)
  - [x] 6.1 Implement `composeResponse(toolOutcomes)`
    - Produce a natural-language response that references every successful tool result and names every failed tool, including the partial-failure case (Req 3.4, 3.5, 3.6)
    - _Requirements: 3.4, 3.5, 3.6_
  - [x] 6.2 Implement dependency-error normalization
    - Implement a wrapper that converts a downstream failure into a structured error with `type = DEPENDENCY_ERROR` (or `TIMEOUT`) and `dependency` naming the failed dependency, preserving the shared `traceId` (Req 13.5)
    - _Requirements: 13.5_
  - [x] 6.3 Write property test for response composition
    - **Property 3: Agent response composition over mixed tool results** — composed response references every success and names every failed tool
    - **Validates: Requirements 3.4, 3.5, 3.6**
    - Mixed tool-result generator (each success or failure); fast-check ≥100 iterations; tag accordingly
  - [x] 6.4 Write property test for dependency-error shape
    - **Property 15: Structured dependency-error shape** — any downstream failure yields `type = DEPENDENCY_ERROR` or `TIMEOUT` with `dependency` naming the failed dependency
    - **Validates: Requirements 13.5**
    - fast-check ≥100 iterations; tag accordingly

- [x] 7. Implement CloudFront path-routing classifier and trace-id propagation (pure)
  - [x] 7.1 Implement path-routing classifier
    - Implement `classifyPath(path)` selecting the API behavior iff the path matches the API prefix (`/api/*`), else the S3_Origin behavior; this logic is reused by the CDK cache-behavior config (Req 7.5, 7.6)
    - _Requirements: 7.5, 7.6_
  - [x] 7.2 Implement trace-id creation and propagation helper
    - Create a `traceId` at the API layer and thread it into agent invocation and each MCP tool invocation payload (Req 12.5)
    - _Requirements: 12.5_
  - [x] 7.3 Write property test for path routing
    - **Property 11: Path routing** — API behavior iff path matches `/api/*`, else S3_Origin behavior
    - **Validates: Requirements 7.5, 7.6**
    - Path generator spanning API-prefixed and non-prefixed paths; fast-check ≥100 iterations; tag accordingly
  - [x] 7.4 Write property test for trace-id propagation
    - **Property 13: Shared trace-id propagation** — every MCP tool invocation emitted for a request carries the identical traceId created at the API layer
    - **Validates: Requirements 12.5**
    - Simulate request handling with a spy on tool invocations; fast-check ≥100 iterations; tag accordingly

- [x] 8. Implement runtime config loader with no code fallback (pure/shared)
  - [x] 8.1 Implement `loadConfig(key)` abstraction
    - Read config/secrets from a `ConfigSource` (SSM/Secrets Manager behind an interface); if a required key is missing return `CONFIG_ERROR` and never return an embedded source-code value (Req 15.2, 15.3)
    - _Requirements: 15.2, 15.3_
  - [x] 8.2 Write property test for config retrieval with no code fallback
    - **Property 17: Config retrieval has no code fallback** — any missing required key yields `CONFIG_ERROR`, never a source-embedded value
    - **Validates: Requirements 15.3**
    - Fake ConfigSource with randomly-present/absent keys; fast-check ≥100 iterations; tag accordingly

- [x] 9. Implement seed data set and seed/precheck helpers (pure)
  - [x] 9.1 Author seed policy data and integrity helper
    - Create ≥ 5 unique `PolicyRecord`s each with coverage, deductible, and prior-claim data; implement `validateSeedSet(records)` enforcing ≥5 records, required sections present, and pairwise-distinct policyIds (Req 5.2, 5.3)
    - _Requirements: 5.2, 5.3_
  - [x] 9.2 Implement duplicate-aware seed-apply helper
    - Implement a conditional put that reports a duplicate-identifier error and does not overwrite an existing policyId (Req 5.4)
    - _Requirements: 5.4_
  - [x] 9.3 Implement DNS record-name precheck helper
    - Implement `dnsPrecheck(recordName, zoneSnapshot)` proceeding only if the name differs from `www.awsteach.com` and is absent from the zone; otherwise report a conflict and signal halt without changing any record (Req 9.2, 9.4)
    - _Requirements: 9.2, 9.4_
  - [x] 9.4 Write property test for seed integrity
    - **Property 7: Seed integrity** — seeded table has ≥5 records, each with coverage/deductible/prior-claim data, all policyIds pairwise distinct
    - **Validates: Requirements 5.2, 5.3**
    - Policy-store generator with unique ids; fast-check ≥100 iterations; tag accordingly
  - [x] 9.5 Write property test for duplicate-identifier seeding rejection
    - **Property 8: Duplicate-identifier seeding is rejected** — a seed batch containing an existing policyId reports a duplicate-identifier error and leaves the pre-existing record unchanged
    - **Validates: Requirements 5.4**
    - Generator producing deliberately duplicated ids; fast-check ≥100 iterations; tag accordingly
  - [x] 9.6 Write property test for DNS record-name precheck
    - **Property 12: DNS record name precheck** — proceed iff name ≠ `www.awsteach.com` and absent from zone; else report conflict and signal halt with no record change
    - **Validates: Requirements 9.2, 9.4**
    - Generator over record names (incl. `www`) and zone snapshots; fast-check ≥100 iterations; tag accordingly

- [x] 10. Checkpoint — all 17 property tests present and passing
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Implement the API_Layer Chat Handler Lambda
  - [x] 11.1 Implement the handler
    - Wire request validation (task 2), config loader (task 8), traceId creation (task 7.2), Bedrock_Agent invocation, and response mapping: 200 on success; 400 on validation failure (agent not invoked) naming the constraint; 502 on agent failure/timeout with a structured agent-failure error; apply a 25s agent-invocation timeout; `CONFIG_ERROR` if config unavailable with no embedded fallback (Req 2.1, 2.2, 2.4, 2.5, 13.1, 13.5, 15.2, 15.3)
    - _Requirements: 2.1, 2.2, 2.4, 2.5, 12.5, 13.1, 13.5, 15.2, 15.3_
  - [x] 11.2 Write unit tests for API handler mapping
    - Success → 200 (2.2); validation failure → 400 without agent invoke (2.4); agent error/timeout → 502 (2.5); config loader reads from Config_Store at runtime (15.2)
    - _Requirements: 2.2, 2.4, 2.5, 15.2_

- [x] 12. Implement the Policy_Lookup_Server MCP server
  - [x] 12.1 Wire pure policy logic into an MCP server with a DynamoDB-backed store
    - Expose `get_coverage`, `get_deductibles`, `get_prior_claims` MCP tools; implement a `PolicyStore` DynamoDB adapter performing read-only queries; validate tool input via schema before processing; load table name from Config_Store; emit logs/metrics with the shared traceId (Req 4.1–4.6, 10.2, 12.1, 12.2, 12.5, 13.2, 15.2)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 10.2, 12.1, 12.2, 12.5, 13.2, 15.2_

- [x] 13. Implement the Repair_Estimator_Server MCP server
  - [x] 13.1 Wire pure estimator logic into an MCP server
    - Expose the `estimate_repair` MCP tool; validate `Claim_Input` via schema before processing; return the deterministic estimate; load config from Config_Store; emit logs/metrics with the shared traceId (Req 6.1–6.5, 12.1, 12.2, 12.5, 13.3, 15.2)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 12.1, 12.2, 12.5, 13.3, 15.2_

- [x] 14. Implement the Bedrock_Agent orchestration wiring
  - [x] 14.1 Configure the agent and tool-invocation layer
    - Define the agent with the two MCP tool groups; implement the invocation layer that routes to policy/repair/both, applies a 20s per-tool timeout, calls MCP servers over transport-encrypted connections propagating the shared traceId, and feeds outcomes into `composeResponse` (task 6.1) with dependency-error wrapping (task 6.2) (Req 3.1, 3.2, 3.3, 3.5, 3.6, 11.5, 12.5)
    - _Requirements: 3.1, 3.2, 3.3, 3.5, 3.6, 11.5, 12.5_

- [x] 15. Implement the static Chat_UI
  - [x] 15.1 Build the single-page Chat_UI
    - Render a text input (1–2000 chars) and conversation history (Req 1.1); submit valid messages over HTTPS to `/api/chat` (Req 1.2); reuse `validateMessageLength` for client-side validation showing the allowed-range error and retaining text (Req 1.3); show pending indicator (Req 1.5); enforce a 30s client timeout removing the indicator and showing a timeout error (Req 1.6); render success as a new history entry (Req 1.4); on error remove indicator, show a failure-identifying message, and preserve history (Req 1.7); embed no secrets (same-origin API path)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_
  - [x] 15.2 Write unit/interaction tests for Chat_UI
    - Input + history present (1.1); valid submit fires request (1.2); response renders as new entry (1.4); pending indicator shown (1.5); 30s timeout path using fake timers (1.6); error path preserves history (1.7)
    - _Requirements: 1.1, 1.2, 1.4, 1.5, 1.6, 1.7_

- [x] 16. Checkpoint — application components wired
  - Ensure all tests pass, ask the user if questions arise.

- [x] 17. Implement the CDK infrastructure — data, storage, and config
  - [x] 17.1 Define Policy_Table, S3_Origin, and Config_Store constructs
    - Define DynamoDB `Policy_Table` (on-demand, encryption at rest, `policyId` partition key) in `us-east-2`; S3 `S3_Origin` with encryption at rest and OAC-only access; SSM/Secrets `Config_Store` entries; a seeding custom resource using the duplicate-aware seed-apply helper (task 9.2) with the seed data (task 9.1) (Req 5.1, 5.2, 5.4, 5.5, 7.2, 11.1, 11.2, 14.6, 15.1)
    - _Requirements: 5.1, 5.2, 5.4, 5.5, 7.2, 11.1, 11.2, 14.6, 15.1_

- [x] 18. Implement the CDK infrastructure — compute, API, agent, and MCP runtime
  - [x] 18.1 Define Lambda, API Gateway, agent, and AgentCore runtime constructs
    - Define the chat handler Lambda, API Gateway (`/api/chat`, min TLS 1.2) in `us-east-2`; deploy both MCP servers to AgentCore Runtime in `us-east-2`; define the Bedrock_Agent; wire Config_Store references into each (Req 4.1, 6.1, 8.1, 11.3)
    - _Requirements: 4.1, 6.1, 8.1, 11.3_
  - [x] 18.2 Define dedicated least-privilege IAM roles
    - One dedicated role per component (agent, API Lambda, policy-lookup, repair-estimator); policy-lookup read-only on the table; grant each component read access only to the Config_Store entries it needs; no wildcard/extra permissions (Req 10.1, 10.2, 10.3, 15.4)
    - _Requirements: 10.1, 10.2, 10.3, 15.4_

- [x] 19. Implement the CDK infrastructure — certificate, CloudFront, DNS, and observability
  - [x] 19.1 Define ACM certificate (us-east-1) with validation gate
    - Create the ACM_Certificate in `us-east-1`; require issued+validated before provisioning CloudFront; halt with a certificate-validation failure identifying the certificate on failure (Req 8.2, 8.3, 8.4)
    - _Requirements: 8.2, 8.3, 8.4_
  - [x] 19.2 Define CloudFront_Distribution and cache behaviors
    - Serve S3_Origin assets via OAC read-only; viewer protocol HTTPS with min TLS 1.2 and HTTP→HTTPS redirect; `/api/*` behavior → API_Layer, default behavior → S3_Origin using the classifier semantics (task 7.1); use the `us-east-1` certificate (Req 7.1, 7.3, 7.4, 7.5, 7.6, 8.4, 10.4)
    - _Requirements: 7.1, 7.3, 7.4, 7.5, 7.6, 8.4, 10.4_
  - [x] 19.3 Define App_DNS_Record with precheck halt
    - Create a new unique record (e.g., `ohio.awsteach.com`) in the `awsteach.com` hosted zone pointing to CloudFront, using the precheck helper (task 9.3) to halt the entire deployment on name conflict and leave `www.awsteach.com` and all records unchanged (Req 9.1, 9.2, 9.3, 9.4)
    - _Requirements: 9.1, 9.2, 9.3, 9.4_
  - [x] 19.4 Define observability (logs, metrics, alarms) in us-east-2
    - Log groups for all four components; invocation/error/latency metrics for the API Lambda and MCP servers; alarms at 5% error rate over a 5-minute window with ALARM/OK transitions; place CloudWatch resources in `us-east-2` (Req 8.5, 12.1, 12.2, 12.3, 12.4)
    - _Requirements: 8.5, 12.1, 12.2, 12.3, 12.4_
  - [x] 19.5 Implement teardown reporting
    - Ensure the stack supports destroy; add a teardown step/script that reports any resources that could not be removed (Req 14.4, 14.5)
    - _Requirements: 14.4, 14.5_

- [x] 20. Checkpoint — infrastructure defined
  - Ensure all tests pass and `cdk synth` succeeds, ask the user if questions arise.

- [x] 21. Infrastructure synthesis / snapshot tests
  - [x] 21.1 Write region & certificate placement synthesis tests
    - Assert all core resources and CloudWatch in `us-east-2`; ACM in `us-east-1`; CloudFront uses the `us-east-1` certificate
    - _Requirements: 8.1, 8.4, 8.5_
  - [x] 21.2 Write encryption-at-rest synthesis tests
    - Assert encryption at rest on `Policy_Table` and `S3_Origin`
    - _Requirements: 5.5, 7.2, 11.1, 11.2_
  - [x] 21.3 Write CloudFront/API transport synthesis tests
    - Assert viewer protocol HTTPS, min TLS 1.2, HTTP→HTTPS redirect, S3 + `/api/*` behaviors, and API Gateway min TLS 1.2 policy
    - _Requirements: 7.1, 7.3, 7.4, 11.3_
  - [x] 21.4 Write IAM least-privilege synthesis tests
    - Assert a dedicated non-shared role per component, policy-lookup read-only on the table, CloudFront OAC read-only on S3, and no wildcard/extra permissions
    - _Requirements: 10.1, 10.2, 10.3, 10.4_
  - [x] 21.5 Write observability synthesis tests
    - Assert log groups for all four components; invocation/error/latency metrics for API Lambda and MCP servers; alarm threshold 5% over 5-minute window with ALARM/OK transitions
    - _Requirements: 12.1, 12.2, 12.3, 12.4_
  - [x] 21.6 Write DNS and config/secrets synthesis tests
    - Assert `App_DNS_Record` targets CloudFront with a name distinct from `www.awsteach.com`; config/secrets sourced from Config_Store with per-component least-privilege read scoping; no embedded secrets in source
    - _Requirements: 9.1, 9.2, 14.1, 14.6, 15.1, 15.4_
  - [x] 21.7 Write IaC idempotence test
    - **Property 16: IaC idempotence** — re-applying against an already-provisioned environment produces an empty change set, leaving resources unchanged (assert empty diff via `cdk diff`/synth comparison)
    - **Validates: Requirements 14.3**
    - fast-check ≥100 iterations over provisioned-state fixtures where feasible; tag `Feature: claimclarify, Property 16: ...`

- [x] 22. Integration tests
  - [x] 22.1 Write agent orchestration/routing integration tests
    - Policy-only, repair-only, and combined queries invoke the expected tool(s) before composing, using a mocked/sandboxed agent
    - _Requirements: 3.1, 3.2, 3.3_
  - [x] 22.2 Write API-to-agent and transport integration tests
    - API forwards a valid request to the agent (2.1); agent-to-MCP calls use transport-encrypted connections (11.5)
    - _Requirements: 2.1, 11.5_
  - [x] 22.3 Write certificate and DNS integration tests
    - ACM certificate created in `us-east-1` and issued/validated before CloudFront, with a simulated-failure halt case (8.2, 8.3); `www.awsteach.com` unchanged across apply (9.3)
    - _Requirements: 8.2, 8.3, 9.3_
  - [x] 22.4 Write apply/teardown integration tests
    - IaC apply provisions all resources; teardown removes them and reports failures
    - _Requirements: 14.2, 14.4, 14.5_

- [x] 23. Smoke tests
  - [x] 23.1 Write deployment smoke tests
    - MCP servers deployed to AgentCore Runtime in `us-east-2` and reachable (4.1, 6.1); non-TLS request to the API endpoint is rejected (11.4); deployed stack serves the Chat_UI over HTTPS at the `App_DNS_Record` URL
    - _Requirements: 4.1, 6.1, 11.4_

- [x] 24. Final checkpoint — full verification
  - Ensure all unit, property, synthesis, integration, and smoke tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (all test tasks) and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirements for traceability; property tasks additionally reference their design property number.
- All 17 correctness properties are covered by dedicated property-based test tasks (2.2, 2.3, 2.4, 3.3, 3.4, 4.3, 4.4, 4.5, 6.3, 6.4, 7.3, 7.4, 8.2, 9.4, 9.5, 9.6, 21.7) using fast-check with ≥100 iterations and the required `Feature: claimclarify, Property <N>: <text>` tag.
- Infrastructure-only concerns (region placement, encryption config, IAM least-privilege, alarms, ACM ordering, non-TLS rejection, agent LLM routing) are validated via synthesis/snapshot, integration, and smoke tests rather than property tests, per the design's testing strategy.
- Pure logic is built and property-tested first (tasks 2–9) so errors surface before AWS wiring; application components (tasks 11–15) and infrastructure (tasks 17–19) build on that foundation; verification tests (21–23) close the loop.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "3.1", "4.1", "6.1", "6.2", "7.1", "7.2", "8.1", "9.1", "9.3"] },
    { "id": 2, "tasks": ["3.2", "4.2", "9.2"] },
    { "id": 3, "tasks": ["2.2", "2.3", "2.4", "3.3", "3.4", "4.3", "4.4", "4.5", "6.3", "6.4", "7.3", "7.4", "8.2", "9.4", "9.5", "9.6"] },
    { "id": 4, "tasks": ["11.1", "12.1", "13.1", "15.1"] },
    { "id": 5, "tasks": ["11.2", "14.1", "15.2"] },
    { "id": 6, "tasks": ["17.1", "18.1"] },
    { "id": 7, "tasks": ["18.2", "19.1"] },
    { "id": 8, "tasks": ["19.2", "19.3", "19.4", "19.5"] },
    { "id": 9, "tasks": ["21.1", "21.2", "21.3", "21.4", "21.5", "21.6", "21.7"] },
    { "id": 10, "tasks": ["22.1", "22.2", "22.3", "22.4"] },
    { "id": 11, "tasks": ["23.1"] }
  ]
}
```
