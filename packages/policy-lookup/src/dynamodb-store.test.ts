/**
 * Unit tests for the read-only DynamoDB-backed policy store adapter.
 *
 * These tests inject a fake document client — no live AWS, credentials, or
 * network are required. They verify fidelity of a fetched record, the
 * undefined-on-absent behavior that drives NOT_FOUND, and that the adapter only
 * ever issues read-only `GetItem`-style commands (Req 10.2).
 */
import { describe, expect, it, vi } from "vitest";

import type { PolicyRecord } from "@claimclarify/shared";

import {
  DynamoDBPolicyStore,
  type DynamoDbReader,
  type GetItemLike,
} from "./dynamodb-store";

const RECORD: PolicyRecord = {
  policyId: "POL-100001",
  holderName: "Dana Adjuster",
  coverage: {
    collision: true,
    comprehensive: true,
    liabilityLimitUsd: 100000,
    rentalReimbursement: false,
  },
  deductibles: { collisionUsd: 500, comprehensiveUsd: 250 },
  priorClaims: [
    { claimId: "CLM-0001", date: "2023-04-12", amountUsd: 3200, atFault: true },
  ],
};

/** A fake read-only reader that records the commands it receives. */
function fakeReader(item?: Record<string, unknown>): {
  reader: DynamoDbReader;
  commands: GetItemLike[];
} {
  const commands: GetItemLike[] = [];
  const reader: DynamoDbReader = {
    async send(command: GetItemLike) {
      commands.push(command);
      return { Item: item };
    },
  };
  return { reader, commands };
}

/** Build a get-command factory that mimics lib-dynamodb's GetCommand. */
function getCommandFactory(args: {
  TableName: string;
  Key: Record<string, unknown>;
}): GetItemLike {
  return { input: args };
}

describe("DynamoDBPolicyStore", () => {
  it("fetches a record by policyId with a read-only GetItem", async () => {
    const { reader, commands } = fakeReader(
      RECORD as unknown as Record<string, unknown>,
    );
    const store = new DynamoDBPolicyStore({
      client: reader,
      tableName: "Policy_Table",
      getCommandFactory,
    });

    const result = await store.fetch("POL-100001");

    expect(result).toEqual(RECORD);
    expect(commands).toHaveLength(1);
    expect(commands[0].input).toEqual({
      TableName: "Policy_Table",
      Key: { policyId: "POL-100001" },
    });
  });

  it("returns undefined when the item is absent (drives NOT_FOUND)", async () => {
    const { reader } = fakeReader(undefined);
    const store = new DynamoDBPolicyStore({
      client: reader,
      tableName: "Policy_Table",
      getCommandFactory,
    });

    await expect(store.fetch("missing")).resolves.toBeUndefined();
  });

  it("builds a single-record in-memory snapshot for the pure tools", async () => {
    const { reader } = fakeReader(RECORD as unknown as Record<string, unknown>);
    const store = new DynamoDBPolicyStore({
      client: reader,
      tableName: "Policy_Table",
      getCommandFactory,
    });

    const snapshot = await store.snapshotFor("POL-100001");
    expect(snapshot.getCoverage("POL-100001")).toEqual(RECORD.coverage);
    expect(snapshot.getCoverage("other")).toBeUndefined();
  });

  it("honors a custom partition-key attribute name", async () => {
    const { reader, commands } = fakeReader(undefined);
    const store = new DynamoDBPolicyStore({
      client: reader,
      tableName: "Policy_Table",
      partitionKey: "pk",
      getCommandFactory,
    });

    await store.fetch("POL-1");
    expect(commands[0].input.Key).toEqual({ pk: "POL-1" });
  });

  it("never issues a write/delete command (read-only)", async () => {
    const send = vi.fn(async () => ({ Item: undefined }));
    const store = new DynamoDBPolicyStore({
      client: { send } as unknown as DynamoDbReader,
      tableName: "Policy_Table",
      getCommandFactory,
    });

    await store.fetch("POL-1");

    // Only one send, carrying a plain read Key — no update/put/delete payload.
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as GetItemLike;
    expect(Object.keys(command.input)).toEqual(["TableName", "Key"]);
  });
});
