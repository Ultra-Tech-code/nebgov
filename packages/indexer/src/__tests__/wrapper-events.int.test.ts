import { SorobanRpc, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { initDb, pool } from "../db";
import { processEvents } from "../events";

class FakeServer {
  constructor(private events: SorobanRpc.Api.EventResponse[]) {}
  async getEvents() {
    return { events: this.events };
  }
}

function myNativeToScVal(value: any): xdr.ScVal {
  if (Array.isArray(value)) {
    return xdr.ScVal.scvVec(value.map((v) => myNativeToScVal(v)));
  }
  return nativeToScVal(value);
}

function makeEvent(params: {
  contractId: string;
  ledger: number;
  type: string;
  topicArgs: any[];
  value: any;
}): SorobanRpc.Api.EventResponse {
  const topic = [
    nativeToScVal(params.type, { type: "symbol" }),
    ...params.topicArgs.map((a) => myNativeToScVal(a)),
  ];
  const value = myNativeToScVal(params.value);
  return {
    type: "contract",
    ledger: params.ledger,
    contractId: params.contractId as any,
    topic,
    value,
  } as any;
}

describe("wrapper event indexing (integration)", () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    it.skip("DATABASE_URL not set", () => undefined);
    return;
  }

  const WRAPPER = "CWRAPPERTESTADDRESS0000000000000000000000000000000000000000";
  const GOVERNOR = "CGOVERNORTESTADDRESS00000000000000000000000000000000000000";
  const ACCOUNT = "GTESTACCOUNTWRAPPEREVENTS0000000000000000000000000000000";

  beforeAll(async () => {
    await initDb();
    await pool.query("DELETE FROM wrapper_deposits");
    await pool.query("DELETE FROM wrapper_withdrawals");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("indexes deposit event into wrapper_deposits", async () => {
    const deposit = makeEvent({
      contractId: WRAPPER,
      ledger: 123,
      type: "deposit",
      topicArgs: [ACCOUNT],
      value: ["CUNDERLYINGTOKEN", BigInt(500)],
    });

    const server = new FakeServer([deposit]) as unknown as SorobanRpc.Server;
    const latest = await processEvents(
      server,
      { rpcUrl: "http://fake", governorAddress: GOVERNOR, wrapperAddress: WRAPPER, pollIntervalMs: 1 },
      1
    );

    expect(latest).toBe(123);

    const rows = await pool.query(
      "SELECT account, amount, ledger FROM wrapper_deposits WHERE account = $1 ORDER BY id DESC LIMIT 1",
      [ACCOUNT]
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].account).toBe(ACCOUNT);
    expect(String(rows.rows[0].amount)).toBe("500");
    expect(rows.rows[0].ledger).toBe(123);
  });
});

