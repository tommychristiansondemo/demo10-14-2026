# ClaimClarify — Project Knowledge (for students)

_Last updated: 2026-10-15. This document is the single source of truth the
Explorer chatbot uses to answer questions. It describes design and deployment
only. It intentionally contains **no secrets, API keys, credentials, or raw
resource ARNs** — those are never exposed._

---

## 1. What is ClaimClarify?

ClaimClarify is an **auto-insurance claims triage assistant** built as a
classroom demonstration of generative-AI application development on AWS. A
claims adjuster uses a web chat interface to ask about a claim; the system is
designed so an Amazon Bedrock agent orchestrates two backend "MCP" tool servers
to answer: one that looks up policy data, one that estimates repair cost and
damage severity.

There are **two applications** deployed for this class:

1. **ClaimClarify** — the main triage application.
2. **ClaimClarify Explorer** — this student-facing tool (a chatbot + live log
   viewer) that explains everything that was deployed. You are talking to the
   Explorer right now.

---

## 2. Where does ClaimClarify's data come from?

- Policy data (coverage, deductibles, prior-claim history) lives in an **Amazon
  DynamoDB** table called `Policy_Table`, partitioned by `policyId`.
- The table is **seeded at deploy time** with **6 sample policy records**
  (ids `POL-100001` … `POL-100006`), each containing coverage, deductible, and
  prior-claim data. Seeding is done by a Lambda-backed CloudFormation custom
  resource using a *duplicate-aware* apply (it never overwrites an existing
  policy id).
- Repair estimates are **not** stored data — they are computed by deterministic
  logic from a structured `Claim_Input` (vehicle year, impact location,
  driveable, airbag deployed, visible damaged panels).

---

## 3. Which LLM is in use?

- The ClaimClarify agent and the Explorer chatbot both use **Anthropic Claude
  (Sonnet 4.5)** via **Amazon Bedrock** — foundation model
  `anthropic.claude-sonnet-4-5-20250929-v1:0`, invoked through the US
  **cross-region inference profile** `us.anthropic.claude-sonnet-4-5-20250929-v1:0`
  (newer Bedrock models require an inference profile rather than direct
  on-demand model-id invocation). Primary region is `us-east-2`.
- The design originally referenced an older Claude 3 Sonnet model id, which was
  **not available** in `us-east-2`; it was updated at deploy time to the
  currently-available Sonnet 4.5 model.
- Bedrock is always called via an **IAM role** — there are no API keys anywhere
  in the system.

---

## 4. Regions and the two-region design

- **us-east-2 (Ohio)** — the Primary Region. Holds compute, data, API, DNS
  records, CloudFront's companion resources, and all CloudWatch logs/alarms.
- **us-east-1 (N. Virginia)** — the Certificate Region. Holds the ACM
  certificate CloudFront uses, because CloudFront requires its viewer
  certificate in `us-east-1`. The certificate is DNS-validated automatically
  against the shared `awsteach.com` hosted zone.

---

## 5. AWS resource types in use

ClaimClarify (main app) uses the following **distinct AWS resource types**:

1. Amazon DynamoDB (the `Policy_Table`)
2. Amazon S3 (static Chat UI origin bucket)
3. AWS Lambda (the API chat handler + the table-seeding custom resource)
4. Amazon API Gateway (HTTP API at `/api/chat`, with a TLS-1.2 custom domain)
5. Amazon CloudFront (CDN fronting the UI and the API)
6. AWS Certificate Manager / ACM (two certificates: CloudFront's in us-east-1,
   the API custom domain's in us-east-2)
7. Amazon Route 53 (DNS records in `awsteach.com`)
8. AWS Systems Manager Parameter Store (the "Config_Store" for runtime config)
9. Amazon CloudWatch Logs, Metrics, and Alarms (observability)
10. AWS IAM (dedicated least-privilege roles, one per component)

That is **10 distinct AWS service/resource categories** in the currently-deployed
core. Two more are **designed but deferred** (see §8): Amazon Bedrock Agent and
Amazon Bedrock AgentCore Runtime (the two MCP tool servers).

The Explorer app (this tool) adds its own use of: S3, CloudFront, Lambda, API
Gateway, Amazon Bedrock (runtime model invocation), CloudWatch Logs, and IAM.

---

## 6. How the main app is wired (request flow)

1. A browser loads the Chat UI over **HTTPS** from CloudFront (served from the
   S3 origin via Origin Access Control — read-only).
2. The adjuster submits a message; CloudFront routes `/api/*` to **API
   Gateway**, which invokes the **chat handler Lambda**.
3. The Lambda validates the request (non-empty message, ≤ 2000 chars, ≤ 1 MB),
   reads runtime config from **SSM Parameter Store**, and (in the full design)
   invokes the **Bedrock agent**.
4. The agent (full design) calls the two MCP servers over TLS and composes a
   single natural-language triage answer.

Security properties baked in: TLS 1.2 minimum everywhere, HTTP→HTTPS redirect,
encryption at rest on DynamoDB and S3, dedicated least-privilege IAM roles per
component, and configuration/secrets kept in Config_Store rather than in source.

---

## 7. Public URLs

- ClaimClarify main app (Chat UI): **https://ohio.awsteach.com/**
- ClaimClarify API endpoint: **https://ohio.awsteach.com/api/chat**
- ClaimClarify Explorer (this tool): **https://explorer.awsteach.com/**

The pre-existing `www.awsteach.com` record was left completely untouched; this
project only created its own new records (`ohio`, `api.ohio`, `explorer`).

---

## 8. What is deployed now vs. deferred

**Deployed and live (the "core"):**
- DynamoDB `Policy_Table` + its 6 seeded records
- S3 origin + the static Chat UI
- CloudFront distribution (TLS 1.2+, HTTP→HTTPS redirect, OAC read-only to S3)
- API Gateway + the chat handler Lambda
- ACM certificates (us-east-1 for CloudFront, us-east-2 for the API domain)
- Route 53 records for `ohio.awsteach.com` and `api.ohio.awsteach.com`
- SSM Config_Store parameters, CloudWatch log groups + error-rate alarms
- The Explorer app (this chatbot + log viewer)

**Designed but deferred (not yet live):**
- The **Bedrock Agent** and the **two AgentCore Runtime MCP servers**
  (policy-lookup and repair-estimator). These require container images to be
  built and pushed to Amazon ECR, which is net-new work beyond the core deploy.
- While they are deferred, the main app's `/api/chat` returns a deterministic
  "the AI triage agent is not yet connected" response instead of a live
  Bedrock-agent answer. The core infrastructure, validation, data, and delivery
  path are all fully working.

---

## 9. The Explorer app (this tool)

- **Static front end** (HTML/CSS/JS) stored in a dedicated **S3** bucket and
  served over **CloudFront/HTTPS**.
- **All dynamic content comes from Lambda functions:**
  - A **chat Lambda** that reads this `projectknowledge.md` from S3, sends it as
    context to the Bedrock model, logs the prompt and the model's
    response/reasoning to CloudWatch, and returns an answer.
  - A **logs Lambda** that reads recent CloudWatch Logs events (read-only,
    limited to the ClaimClarify + Explorer log groups) and returns them,
    including the Explorer chatbot's own LLM prompt/response ("reasoning")
    entries. It redacts anything resembling a secret before returning it.
- A link to the Explorer is placed on the main ClaimClarify Chat UI page.

**Reasoning / prompt logging:** the Explorer chatbot logs every prompt it sends
to the model and every response it gets, tagged `EXPLORER_REASONING`, so you can
inspect them in the "Live system logs" view (toggle "Show LLM reasoning
entries only"). The original ClaimClarify app's raw LLM prompt logging is **not**
enabled, by instructor choice, to limit data exposure; the Explorer's own
reasoning is fully visible.

---

## 10. Teardown

Everything is defined as infrastructure-as-code (AWS CDK). The whole deployment
can be removed later with the project's teardown tooling; it reports any
resources that could not be deleted. No component runs on any classroom laptop
or instructor server — it is entirely AWS-managed.
