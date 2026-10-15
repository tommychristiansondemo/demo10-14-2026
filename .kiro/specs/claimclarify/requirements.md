# Requirements Document

## Introduction

ClaimClarify is an auto-insurance claims triage assistant built for a classroom demonstration of advanced generative AI development on AWS. A claims adjuster interacts with a web-based chat interface that is backed by an Amazon Bedrock agent. The agent answers questions about a claim by orchestrating calls to two Model Context Protocol (MCP) servers deployed to Amazon Bedrock AgentCore Runtime: a policy-lookup server that retrieves coverage, deductible, and prior-claim data from DynamoDB, and a repair-estimator server that classifies collision damage severity and estimates repair cost and turnaround time.

The application is deployed as repeatable infrastructure-as-code across two AWS regions. Application compute and data reside in us-east-2 (Ohio), while the CloudFront certificate and global pieces reside in us-east-1 (N. Virginia). DNS is served from the existing public hosted zone awsteach.com using new, unique records that do not disturb an unrelated application already using www.awsteach.com. The system must demonstrate enterprise-quality practices including least-privilege IAM, encryption at rest and in transit, observability, input validation, and separation of configuration from secrets.

## Glossary

- **ClaimClarify**: The overall auto-insurance claims triage application described in this document.
- **Adjuster**: A claims adjuster who uses the chat interface to ask questions about a claim.
- **Chat_UI**: The static front-end web application that provides the adjuster chat experience.
- **API_Layer**: The Amazon API Gateway endpoint and associated AWS Lambda functions that connect the Chat_UI to the Bedrock agent.
- **Bedrock_Agent**: The Amazon Bedrock agent that orchestrates calls to the MCP servers to answer adjuster queries.
- **MCP**: Model Context Protocol, the protocol used to expose backend tools to the Bedrock_Agent.
- **AgentCore_Runtime**: Amazon Bedrock AgentCore Runtime, the managed environment hosting the MCP servers.
- **Policy_Lookup_Server**: The MCP server that exposes tools for policy coverage, deductibles, and prior claim history, backed by DynamoDB.
- **Repair_Estimator_Server**: The MCP server that exposes tools to classify collision damage severity and estimate repair cost and turnaround time.
- **Policy_Table**: The Amazon DynamoDB table that stores policy, coverage, deductible, and prior-claim sample data.
- **CloudFront_Distribution**: The Amazon CloudFront distribution that serves the Chat_UI and fronts the API_Layer.
- **S3_Origin**: The Amazon S3 bucket that stores the static Chat_UI assets and serves as the CloudFront origin.
- **ACM_Certificate**: The AWS Certificate Manager TLS certificate used by the CloudFront_Distribution.
- **Hosted_Zone**: The existing public Amazon Route 53 hosted zone for the domain awsteach.com.
- **App_DNS_Record**: The new, unique Route 53 record created by this deployment that points to the CloudFront_Distribution.
- **IaC_Template**: The infrastructure-as-code definition (AWS CDK or Terraform) used to deploy and tear down ClaimClarify.
- **Config_Store**: The AWS Systems Manager Parameter Store or AWS Secrets Manager location that holds configuration values and secrets.
- **Primary_Region**: The AWS region us-east-2 (Ohio) where application compute and data are deployed.
- **Certificate_Region**: The AWS region us-east-1 (N. Virginia) where the ACM_Certificate and CloudFront-tied global resources are deployed.
- **Observability_Service**: Amazon CloudWatch logs, metrics, and alarms, together with request tracing for agent-to-MCP calls.
- **Claim_Input**: The structured set of claim attributes submitted to the Repair_Estimator_Server for damage classification and estimation.

## Requirements

### Requirement 1: Adjuster Chat Interaction

**User Story:** As an adjuster, I want to ask questions about a claim through a chat interface, so that I can triage claims without navigating multiple backend systems.

#### Acceptance Criteria

1. THE Chat_UI SHALL present a text input field that accepts between 1 and 2,000 characters and a conversation history to the Adjuster.
2. WHEN the Adjuster submits a message containing between 1 and 2,000 characters, THE Chat_UI SHALL send the message to the API_Layer over HTTPS.
3. IF the Adjuster submits a message that is empty or exceeds 2,000 characters, THEN THE Chat_UI SHALL reject the submission, SHALL display an error message indicating the allowed length range, and SHALL retain the entered text in the input field.
4. WHEN the API_Layer returns a response, THE Chat_UI SHALL display the response as a new entry in the conversation history.
5. WHILE the Bedrock_Agent is processing a request, THE Chat_UI SHALL display a pending-response indicator to the Adjuster until a response or error is received.
6. IF no response or error is received within 30 seconds of submission, THEN THE Chat_UI SHALL remove the pending-response indicator and SHALL display an error message indicating a timeout.
7. IF the API_Layer returns an error response, THEN THE Chat_UI SHALL remove the pending-response indicator, SHALL display an error message that identifies the failure to the Adjuster, and SHALL preserve the existing conversation history.

### Requirement 2: API Layer Request Handling

**User Story:** As an adjuster, I want my chat messages routed reliably to the agent, so that I receive accurate answers to my claim questions.

#### Acceptance Criteria

1. WHEN the API_Layer receives a chat request from the Chat_UI, THE API_Layer SHALL forward the request to the Bedrock_Agent.
2. WHEN the Bedrock_Agent returns a result, THE API_Layer SHALL return the result to the Chat_UI with an HTTP 200 status code.
3. THE API_Layer SHALL validate, before invoking the Bedrock_Agent, that each request body conforms to the expected request schema, contains a non-empty message field of at most 2,000 characters, and does not exceed a total payload size of 1 MB.
4. IF a received request body fails input validation, THEN THE API_Layer SHALL reject the request with an HTTP 400 status code and an error message indicating which validation constraint was violated, without invoking the Bedrock_Agent.
5. IF the Bedrock_Agent invocation fails or does not return a result within 25 seconds, THEN THE API_Layer SHALL return an HTTP 502 status code and an error message indicating that the agent invocation failed.

### Requirement 3: Bedrock Agent Orchestration

**User Story:** As an adjuster, I want the agent to gather both policy and repair information for a claim, so that I get a complete triage answer in one response.

#### Acceptance Criteria

1. WHEN the Bedrock_Agent receives an adjuster query that requires policy information, THE Bedrock_Agent SHALL invoke a tool on the Policy_Lookup_Server.
2. WHEN the Bedrock_Agent receives an adjuster query that requires damage or repair information, THE Bedrock_Agent SHALL invoke a tool on the Repair_Estimator_Server.
3. WHEN an adjuster query requires both policy and repair information, THE Bedrock_Agent SHALL invoke tools on both the Policy_Lookup_Server and the Repair_Estimator_Server before composing a response.
4. WHEN the Bedrock_Agent receives all requested tool results, THE Bedrock_Agent SHALL compose a natural-language response that incorporates each returned tool result.
5. IF a tool invocation returns an error or does not return a result within 20 seconds, THEN THE Bedrock_Agent SHALL compose a response that identifies which tool failed to the Adjuster.
6. IF one tool returns a result and another tool returns an error within the same query, THEN THE Bedrock_Agent SHALL compose a response that incorporates the successful result and identifies which tool failed.

### Requirement 4: Policy Lookup MCP Server

**User Story:** As an adjuster, I want to retrieve policy coverage, deductibles, and prior claim history, so that I can evaluate whether a claim is covered.

#### Acceptance Criteria

1. THE Policy_Lookup_Server SHALL be deployed to the AgentCore_Runtime in the Primary_Region.
2. WHEN the Policy_Lookup_Server receives a coverage-details request for an existing policy identifier, THE Policy_Lookup_Server SHALL return the coverage details stored in the Policy_Table for that policy identifier within 3 seconds.
3. WHEN the Policy_Lookup_Server receives a deductible request for an existing policy identifier, THE Policy_Lookup_Server SHALL return the deductible amounts stored in the Policy_Table for that policy identifier within 3 seconds.
4. WHEN the Policy_Lookup_Server receives a prior-claim-history request for an existing policy identifier, THE Policy_Lookup_Server SHALL return the prior claim history stored in the Policy_Table for that policy identifier within 3 seconds.
5. IF a requested policy identifier does not exist in the Policy_Table, THEN THE Policy_Lookup_Server SHALL return a not-found result that identifies the missing policy identifier and SHALL leave the Policy_Table unchanged.
6. IF a tool receives an input in which the policy identifier is absent, empty, or exceeds 64 characters, THEN THE Policy_Lookup_Server SHALL return a validation-error result that identifies the invalid input and SHALL leave the Policy_Table unchanged.

### Requirement 5: Policy Data Store

**User Story:** As an instructor, I want realistic sample policy data available at deploy time, so that the demonstration produces meaningful answers.

#### Acceptance Criteria

1. THE Policy_Table SHALL be an Amazon DynamoDB table deployed in the Primary_Region.
2. WHEN the IaC_Template deploys the Policy_Table, THE IaC_Template SHALL seed the Policy_Table with at least 5 policy records, each containing coverage, deductible, and prior-claim data.
3. THE Policy_Table SHALL store each policy record keyed by a policy identifier that is unique across all records in the Policy_Table.
4. IF the IaC_Template attempts to seed a policy record whose policy identifier already exists in the Policy_Table, THEN THE IaC_Template SHALL report a duplicate-identifier error and SHALL NOT overwrite the existing record.
5. THE Policy_Table SHALL be configured with encryption at rest enabled.

### Requirement 6: Repair Estimator MCP Server

**User Story:** As an adjuster, I want the system to classify damage severity and estimate repair cost and turnaround, so that I can prioritize and set expectations for a claim.

#### Acceptance Criteria

1. THE Repair_Estimator_Server SHALL be deployed to the AgentCore_Runtime in the Primary_Region.
2. WHEN the Repair_Estimator_Server receives a valid Claim_Input, THE Repair_Estimator_Server SHALL return a collision damage severity classification from a predefined set of severity levels within 3 seconds.
3. WHEN the Repair_Estimator_Server receives a valid Claim_Input, THE Repair_Estimator_Server SHALL return an estimated repair cost as a non-negative monetary amount within 3 seconds.
4. WHEN the Repair_Estimator_Server receives a valid Claim_Input, THE Repair_Estimator_Server SHALL return an estimated repair turnaround time as a non-negative number of days within 3 seconds.
5. IF a Claim_Input is missing a required attribute or contains an attribute value outside its permitted range, THEN THE Repair_Estimator_Server SHALL return a validation-error result that identifies the invalid input and SHALL NOT return a severity classification, repair cost, or turnaround estimate.

### Requirement 7: Content Delivery and Static Hosting

**User Story:** As an adjuster, I want to reach the chat application over a secure public URL, so that I can use it from a browser.

#### Acceptance Criteria

1. THE CloudFront_Distribution SHALL serve the Chat_UI assets from the S3_Origin.
2. THE S3_Origin SHALL be configured with encryption at rest enabled.
3. THE CloudFront_Distribution SHALL serve all content over HTTPS using a minimum TLS version of 1.2.
4. WHEN a request arrives over HTTP, THE CloudFront_Distribution SHALL return a redirect response that directs the client to the equivalent HTTPS URL.
5. WHEN the CloudFront_Distribution receives a request whose path targets the API, THE CloudFront_Distribution SHALL route the request to the API_Layer.
6. WHEN the CloudFront_Distribution receives a request whose path does not target the API, THE CloudFront_Distribution SHALL serve the corresponding Chat_UI asset from the S3_Origin.

### Requirement 8: Regional Deployment Strategy

**User Story:** As an instructor, I want the application resources placed in the correct regions, so that CloudFront and application components function correctly.

#### Acceptance Criteria

1. THE IaC_Template SHALL deploy the Bedrock_Agent, the AgentCore_Runtime MCP servers, the Policy_Table, the API_Layer, and the S3_Origin in the Primary_Region.
2. WHEN the IaC_Template is applied, THE IaC_Template SHALL create the ACM_Certificate in the Certificate_Region and confirm that the certificate reaches an issued and validated state before provisioning the CloudFront_Distribution.
3. IF the ACM_Certificate does not reach an issued and validated state, THEN THE IaC_Template SHALL halt the deployment and report a certificate validation failure that identifies the ACM_Certificate.
4. THE CloudFront_Distribution SHALL use the ACM_Certificate from the Certificate_Region.
5. THE IaC_Template SHALL deploy application-level CloudWatch logs, metrics, and alarms in the Primary_Region.

### Requirement 9: DNS Record Management

**User Story:** As an instructor, I want this deployment to publish its own unique DNS record, so that an existing application using the same hosted zone remains unaffected.

#### Acceptance Criteria

1. THE IaC_Template SHALL create the App_DNS_Record as a new record in the Hosted_Zone that points to the CloudFront_Distribution.
2. THE App_DNS_Record SHALL use a domain name that is distinct from www.awsteach.com.
3. THE IaC_Template SHALL leave the existing www.awsteach.com record in the Hosted_Zone unchanged.
4. IF the App_DNS_Record name already exists in the Hosted_Zone, THEN THE IaC_Template SHALL report a naming conflict, halt the entire deployment, and leave all existing records in the Hosted_Zone unchanged.

### Requirement 10: Identity and Access Management

**User Story:** As a security reviewer, I want each component to use least-privilege permissions, so that the demonstration reflects enterprise security practices.

#### Acceptance Criteria

1. THE IaC_Template SHALL assign a dedicated IAM role, not shared with any other component, to each of the Bedrock_Agent, the API_Layer Lambda functions, the Policy_Lookup_Server, and the Repair_Estimator_Server.
2. THE IAM role for the Policy_Lookup_Server SHALL grant read access to the Policy_Table and SHALL NOT grant write or delete access to the Policy_Table.
3. THE IAM role for each component SHALL deny every permission that is not required for that component to perform its function.
4. THE IAM role for the Chat_UI delivery path SHALL grant the CloudFront_Distribution read access to the S3_Origin and SHALL NOT grant write or delete access to the S3_Origin.

### Requirement 11: Encryption and Secure Transport

**User Story:** As a security reviewer, I want data encrypted at rest and in transit, so that claim information is protected.

#### Acceptance Criteria

1. THE Policy_Table SHALL be configured with encryption at rest enabled.
2. THE S3_Origin SHALL be configured with encryption at rest enabled.
3. THE API_Layer SHALL accept client connections only over TLS using a minimum TLS version of 1.2.
4. IF a client attempts to connect to the API_Layer without TLS, THEN THE API_Layer SHALL reject the connection.
5. WHEN the Bedrock_Agent invokes a tool on an MCP server, THE Bedrock_Agent SHALL use a transport-encrypted connection.

### Requirement 12: Observability and Tracing

**User Story:** As an operator, I want logs, metrics, alarms, and traces, so that I can monitor and troubleshoot the application.

#### Acceptance Criteria

1. THE Observability_Service SHALL record logs for the Bedrock_Agent, the API_Layer Lambda functions, the Policy_Lookup_Server, and the Repair_Estimator_Server.
2. THE Observability_Service SHALL publish, for the API_Layer Lambda functions and the MCP servers, metrics that include invocation count, error count, and latency.
3. WHEN the error rate for a monitored component exceeds 5 percent over a 5-minute evaluation window, THE Observability_Service SHALL set the corresponding CloudWatch alarm to the ALARM state.
4. WHEN the error rate for a monitored component returns to 5 percent or below over a 5-minute evaluation window, THE Observability_Service SHALL set the corresponding CloudWatch alarm to the OK state.
5. WHEN the Bedrock_Agent invokes a tool on an MCP server, THE Observability_Service SHALL record a trace that links the agent request to the MCP tool invocation using a shared trace identifier.

### Requirement 13: Input Validation and Error Handling

**User Story:** As an adjuster, I want invalid inputs handled gracefully, so that I receive clear feedback instead of unhandled failures.

#### Acceptance Criteria

1. WHEN the API_Layer receives a request, THE API_Layer SHALL validate the request against the expected request schema before forwarding it to the Bedrock_Agent.
2. WHEN the Policy_Lookup_Server receives a tool input, THE Policy_Lookup_Server SHALL validate the input against the expected tool schema before processing it.
3. WHEN the Repair_Estimator_Server receives a Claim_Input, THE Repair_Estimator_Server SHALL validate the Claim_Input against the expected input schema before processing it.
4. IF a component receives input that fails validation, THEN THE component SHALL return a structured error result that identifies the failing field and the nature of the validation failure.
5. IF a downstream dependency returns an error, THEN THE calling component SHALL return a structured error result that identifies the failed dependency and the nature of the failure.

### Requirement 14: Infrastructure as Code and Teardown

**User Story:** As an instructor, I want the entire stack defined as code with teardown support, so that I can deploy and remove the demonstration repeatably.

#### Acceptance Criteria

1. THE IaC_Template SHALL define all ClaimClarify resources using AWS CDK or Terraform.
2. WHEN the IaC_Template is applied, THE IaC_Template SHALL provision all ClaimClarify resources required for the application to operate.
3. WHEN the IaC_Template is applied again against an already-provisioned environment, THE IaC_Template SHALL leave the already-provisioned resources unchanged.
4. WHEN a teardown operation is executed, THE IaC_Template SHALL remove all ClaimClarify resources that the IaC_Template created.
5. IF a teardown operation fails to remove one or more resources, THEN THE IaC_Template SHALL report which resources were not removed.
6. THE IaC_Template SHALL store configuration values and secrets in the Config_Store rather than in source code.

### Requirement 15: Configuration and Secrets Separation

**User Story:** As a security reviewer, I want configuration and secrets kept out of code, so that credentials are not exposed.

#### Acceptance Criteria

1. THE Config_Store SHALL hold environment-specific configuration values for ClaimClarify.
2. WHEN a component requires a configuration value or secret at runtime, THE component SHALL retrieve the value from the Config_Store.
3. IF a component cannot retrieve a required configuration value or secret from the Config_Store, THEN THE component SHALL report a configuration-retrieval failure and SHALL NOT fall back to a value embedded in source code.
4. THE IaC_Template SHALL grant each component read access to the Config_Store entries that the component requires and SHALL NOT grant access to Config_Store entries that the component does not require.
