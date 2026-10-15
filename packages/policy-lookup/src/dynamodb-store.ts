/**
 * DynamoDB-backed adapter for the Policy_Lookup_Server (task 12.1).
 *
 * The adapter performs READ-ONLY access to the `Policy_Table` — it only ever
 * issues `GetItem` and never `PutItem`/`UpdateItem`/`DeleteItem`, honoring the
 * least-privilege read-only contract (Req 10.2). The underlying DynamoDB client
 * is injected so the adapter is unit-testable without live AWS: tests pass a
 * fake `DynamoDBDocumentClient` and no network or credentials are required to
 * build or test (Req 4.2, 4.3, 4.4).
 *
 * Because the pure lookup tools operate over the synchronous {@link PolicyStore}
 * interface, this adapter exposes an async {@link AsyncPolicyStore#fetch} that
 * returns the full {@link PolicyRecord} for a `policyId` (or `undefined` when
 * absent). The dispatch layer (tool-registry) wraps a fetched record in an
 * {@link InMemoryPolicyStore} snapshot and then calls the existing pure tool
 * functions, so all read semantics (fidelity, NOT_FOUND, validation) remain the
 * single source of truth.
 */
import type { PolicyRecord } from "@claimclarify/shared";

import { InMemoryPolicyStore, type PolicyStore } from "./store";

/**
 * The minimal, read-only slice of a DynamoDB document client the adapter needs.
 * Modelled on `@aws-sdk/lib-dynamodb`'s `DynamoDBDocumentClient#send` with the
 * `GetCommand`, but reduced to the one operation we use so it is trivial to
 * fake in tests and so the adapter cannot perform writes.
 */
export interface DynamoDbReader {
  send(command: GetItemLike): Promise<{ Item?: Record<string, unknown> }>;
}

/**
 * A marker type representing an `@aws-sdk/lib-dynamodb` `GetCommand` instance.
 * We only ever construct `GetCommand`s, so the reader is read-only by
 * construction (Req 10.2).
 */
export interface GetItemLike {
  readonly input: {
    TableName: string;
    Key: Record<string, unknown>;
  };
}

/** Factory that builds a read-only get command for a `policyId`. */
export type GetCommandFactory = (args: {
  TableName: string;
  Key: Record<string, unknown>;
}) => GetItemLike;

/**
 * Async, read-only store contract satisfied by the DynamoDB adapter. Returns
 * the full policy record for a `policyId`, or `undefined` when the id is absent
 * from the table (so the caller can produce a structured NOT_FOUND — Req 4.5).
 */
export interface AsyncPolicyStore {
  fetch(policyId: string): Promise<PolicyRecord | undefined>;
}

/** Options for constructing a {@link DynamoDBPolicyStore}. */
export interface DynamoDBPolicyStoreOptions {
  /** Injected read-only document client (real or fake). */
  client: DynamoDbReader;
  /** The Policy_Table name, loaded from Config_Store at runtime (Req 15.2). */
  tableName: string;
  /** The partition-key attribute name. Defaults to `policyId` (Req 5.3). */
  partitionKey?: string;
  /**
   * Factory for the read-only get command. Defaults to constructing an
   * `@aws-sdk/lib-dynamodb` `GetCommand`. Injectable for tests.
   */
  getCommandFactory?: GetCommandFactory;
}

/**
 * Read-only {@link AsyncPolicyStore} backed by DynamoDB via an injected
 * document client. Never writes or deletes (Req 10.2).
 */
export class DynamoDBPolicyStore implements AsyncPolicyStore {
  private readonly client: DynamoDbReader;
  private readonly tableName: string;
  private readonly partitionKey: string;
  private readonly getCommandFactory: GetCommandFactory;

  constructor(options: DynamoDBPolicyStoreOptions) {
    this.client = options.client;
    this.tableName = options.tableName;
    this.partitionKey = options.partitionKey ?? "policyId";
    this.getCommandFactory = options.getCommandFactory ?? defaultGetCommand;
  }

  /**
   * Read the policy record for `policyId` using a single `GetItem` (read-only).
   * Returns `undefined` when the item is absent so the caller emits NOT_FOUND
   * (Req 4.5). No mutation of the table ever occurs (Req 10.2).
   */
  async fetch(policyId: string): Promise<PolicyRecord | undefined> {
    const command = this.getCommandFactory({
      TableName: this.tableName,
      Key: { [this.partitionKey]: policyId },
    });
    const result = await this.client.send(command);
    if (result.Item === undefined) {
      return undefined;
    }
    return result.Item as unknown as PolicyRecord;
  }

  /**
   * Build a synchronous {@link PolicyStore} snapshot for a single fetched
   * record (or an empty store when absent). This lets the existing pure lookup
   * tools run unchanged over DynamoDB-sourced data.
   */
  async snapshotFor(policyId: string): Promise<PolicyStore> {
    const record = await this.fetch(policyId);
    return new InMemoryPolicyStore(record ? [record] : []);
  }
}

/**
 * Default {@link GetCommandFactory} that lazily requires `@aws-sdk/lib-dynamodb`
 * so that merely importing this module (e.g. in unit tests that inject a fake
 * client and factory) does not force the AWS SDK to load.
 */
const defaultGetCommand: GetCommandFactory = (args) => {
  // Lazy require keeps the AWS SDK out of the import path for pure unit tests.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { GetCommand } = require("@aws-sdk/lib-dynamodb") as {
    GetCommand: new (input: {
      TableName: string;
      Key: Record<string, unknown>;
    }) => GetItemLike;
  };
  return new GetCommand(args);
};

/**
 * Build a read-only {@link DynamoDbReader} from the AWS SDK, wrapping a
 * `DynamoDBClient` in a `DynamoDBDocumentClient`. Lazily requires the AWS SDK so
 * unit tests that inject a fake client never load it. Live AWS is only touched
 * when a command is actually sent, so this is safe to call at build/test time.
 */
export function createDynamoDbReader(options?: {
  region?: string;
}): DynamoDbReader {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DynamoDBClient } = require("@aws-sdk/client-dynamodb") as {
    DynamoDBClient: new (config: { region?: string }) => unknown;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb") as {
    DynamoDBDocumentClient: {
      from(client: unknown): DynamoDbReader;
    };
  };
  const base = new DynamoDBClient({ region: options?.region });
  return DynamoDBDocumentClient.from(base);
}
