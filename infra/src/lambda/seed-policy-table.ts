/**
 * Seeding custom-resource Lambda for the Policy_Table (Req 5.2, 5.4).
 *
 * On stack create/update this handler seeds the Policy_Table with the shared
 * {@link SEED_POLICIES} data set, using the duplicate-aware {@link applySeed}
 * helper to decide what to write. `applySeed` enforces conditional-put
 * semantics purely: it reads the table's current contents, and if any seed
 * `policyId` already exists it reports a duplicate-identifier error and nothing
 * is overwritten (Req 5.4). Only the records `applySeed` reports as `applied`
 * are written back, each with a `attribute_not_exists(policyId)` condition so
 * concurrent writers cannot clobber an existing record either.
 *
 * The handler imports the seed data and helper from `@claimclarify/shared`; it
 * contains no embedded copy of the seed set (single source of truth).
 */
import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
  type ScanCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import {
  SEED_POLICIES,
  applySeed,
  validateSeedSet,
  type PolicyRecord,
} from "@claimclarify/shared";

/** Minimal shape of the CloudFormation custom-resource event we rely on. */
interface CustomResourceEvent {
  RequestType: "Create" | "Update" | "Delete";
  ResourceProperties?: { TableName?: string };
}

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** Read every existing record from the table so seeding is duplicate-aware. */
async function readExisting(tableName: string): Promise<PolicyRecord[]> {
  const records: PolicyRecord[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const page: ScanCommandOutput = await client.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: lastEvaluatedKey,
      })
    );
    for (const item of page.Items ?? []) {
      records.push(item as PolicyRecord);
    }
    lastEvaluatedKey = page.LastEvaluatedKey;
  } while (lastEvaluatedKey !== undefined);
  return records;
}

/**
 * CloudFormation custom-resource entry point. Seeds on Create/Update and is a
 * no-op on Delete (the table itself is removed by its own removal policy).
 */
export async function handler(
  event: CustomResourceEvent
): Promise<{ PhysicalResourceId: string; Data: Record<string, unknown> }> {
  const physicalResourceId = "claimclarify-policy-table-seed";

  if (event.RequestType === "Delete") {
    return { PhysicalResourceId: physicalResourceId, Data: {} };
  }

  const tableName = event.ResourceProperties?.TableName;
  if (!tableName) {
    throw new Error("Seeding custom resource requires a TableName property.");
  }

  // Fail fast if the shared seed set itself violates its integrity invariants.
  const integrity = validateSeedSet(SEED_POLICIES);
  if (!integrity.ok) {
    throw new Error(
      `Seed set failed integrity validation: ${integrity.error.message}`
    );
  }

  const existing = await readExisting(tableName);
  const result = applySeed(existing, SEED_POLICIES);
  if (!result.ok) {
    // Duplicate-identifier error: report it and do not overwrite (Req 5.4).
    throw new Error(result.error.message);
  }

  for (const record of result.applied) {
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: record,
        // Belt-and-suspenders: never overwrite an existing record.
        ConditionExpression: "attribute_not_exists(policyId)",
      })
    );
  }

  return {
    PhysicalResourceId: physicalResourceId,
    Data: { SeededCount: result.applied.length },
  };
}
