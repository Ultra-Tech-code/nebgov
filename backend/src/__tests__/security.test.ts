import { AlertType, AlertSeverity, SecurityMonitorService } from "../services/security-monitor";
import pool from "../db/pool";

// Mock pool
jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

const queryMock = pool.query as jest.Mock;

describe("SecurityMonitorService", () => {
  let service: SecurityMonitorService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TOKEN_VOTES_CONTRACT_ID = "CTOKENVOTES123";
    process.env.GOVERNOR_CONTRACT_ID = "CENVGOVERNOR123";
    service = new SecurityMonitorService();
  });

  afterEach(() => {
    delete process.env.TOKEN_VOTES_CONTRACT_ID;
    delete process.env.GOVERNOR_CONTRACT_ID;
  });

  it("should define correctly the AlertType and AlertSeverity", () => {
    expect(AlertType.LARGE_TRANSFER).toBe("LARGE_TRANSFER");
    expect(AlertSeverity.CRITICAL).toBe("CRITICAL");
  });

  // Since most methods are private or depend on Horizon, 
  // we test the pattern identification logic if it was exposed.
  // For now, we'll just verify the service initializes.
  it("should initialize with default horizon server", () => {
    expect(service).toBeDefined();
  });

  it("uses governor contract ID from DB when available", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ value: "CDBGOVERNOR123" }] });

    const checkGovernorSpy = jest
      .spyOn(service as any, "checkGovernorEvents")
      .mockResolvedValue(undefined);
    const checkTokenVotesSpy = jest
      .spyOn(service as any, "checkTokenVotesEvents")
      .mockResolvedValue(undefined);

    await (service as any).processEvents(10, 20);

    expect(queryMock).toHaveBeenCalledWith(
      "SELECT value FROM monitoring_state WHERE key = 'active_governor_contract_id' LIMIT 1",
    );
    expect(checkGovernorSpy).toHaveBeenCalledWith("CDBGOVERNOR123", 10, 20);
    expect(checkTokenVotesSpy).toHaveBeenCalledWith("CTOKENVOTES123", 10, 20);
  });

  it("falls back to environment governor contract ID when DB has no value", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const checkGovernorSpy = jest
      .spyOn(service as any, "checkGovernorEvents")
      .mockResolvedValue(undefined);
    const checkTokenVotesSpy = jest
      .spyOn(service as any, "checkTokenVotesEvents")
      .mockResolvedValue(undefined);

    await (service as any).processEvents(11, 21);

    expect(checkGovernorSpy).toHaveBeenCalledWith("CENVGOVERNOR123", 11, 21);
    expect(checkTokenVotesSpy).toHaveBeenCalledWith("CTOKENVOTES123", 11, 21);
  });

  it("picks up governor contract ID changes from DB without restart", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ value: "CDBGOVERNOR_OLD" }] })
      .mockResolvedValueOnce({ rows: [{ value: "CDBGOVERNOR_NEW" }] });

    const checkGovernorSpy = jest
      .spyOn(service as any, "checkGovernorEvents")
      .mockResolvedValue(undefined);
    const checkTokenVotesSpy = jest
      .spyOn(service as any, "checkTokenVotesEvents")
      .mockResolvedValue(undefined);

    await (service as any).processEvents(12, 22);
    await (service as any).processEvents(23, 33);

    expect(checkGovernorSpy).toHaveBeenNthCalledWith(1, "CDBGOVERNOR_OLD", 12, 22);
    expect(checkGovernorSpy).toHaveBeenNthCalledWith(2, "CDBGOVERNOR_NEW", 23, 33);
    expect(checkTokenVotesSpy).toHaveBeenCalledTimes(2);
  });
});
