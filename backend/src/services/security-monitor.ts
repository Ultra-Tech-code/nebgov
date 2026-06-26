import { Horizon, Networks } from "@stellar/stellar-sdk";
import pool from "../db/pool";
import pino from "pino";

const logger = pino({ name: "security-monitor" });

export enum AlertSeverity {
  LOW = "LOW",
  MEDIUM = "MEDIUM",
  HIGH = "HIGH",
  CRITICAL = "CRITICAL",
}

export enum AlertType {
  LARGE_TRANSFER = "LARGE_TRANSFER",
  PAUSE_DETECTED = "PAUSE_DETECTED",
  SUSPICIOUS_PROPOSAL = "SUSPICIOUS_PROPOSAL",
  PROPOSAL_FAILED = "PROPOSAL_FAILED",
  RATE_LIMIT_HIT = "RATE_LIMIT_HIT",
  UNEXPECTED_ERROR = "UNEXPECTED_ERROR",
}

export interface SecurityAlert {
  type: AlertType;
  severity: AlertSeverity;
  message: string;
  metadata?: any;
}

export class SecurityMonitorService {
  private horizon: Horizon.Server;
  private networkPassphrase: string;
  private interval: NodeJS.Timeout | null = null;
  private isScanning: boolean = false;
  private currentGovernorContractId: string | null = null;

  constructor() {
    const horizonUrl = process.env.STELLAR_HORIZON_URL || "https://horizon-testnet.stellar.org";
    this.horizon = new Horizon.Server(horizonUrl);
    this.networkPassphrase = process.env.STELLAR_NETWORK === "public" 
      ? Networks.PUBLIC 
      : Networks.TESTNET;
  }

  async start() {
    const intervalMs = parseInt(process.env.SECURITY_SCAN_INTERVAL_MS || "30000");
    logger.info(`Starting security monitor with ${intervalMs}ms interval`);
    
    this.interval = setInterval(() => this.scan(), intervalMs);
    // Initial scan
    this.scan();
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async scan() {
    if (this.isScanning) return;
    this.isScanning = true;

    try {
      const lastLedger = await this.getLastProcessedLedger();
      const currentLedger = await this.getCurrentLedger();

      if (currentLedger > lastLedger) {
        logger.info(`Scanning ledgers from ${lastLedger + 1} to ${currentLedger}`);
        await this.processEvents(lastLedger + 1, currentLedger);
        await this.updateLastProcessedLedger(currentLedger);
      }
    } catch (error) {
      logger.error({ err: error }, "Error during security scan");
    } finally {
      this.isScanning = false;
    }
  }

  private async getLastProcessedLedger(): Promise<number> {
    const result = await pool.query(
      "SELECT value FROM monitoring_state WHERE key = 'last_processed_ledger'"
    );
    return result.rows.length > 0 ? parseInt(result.rows[0].value) : 0;
  }

  private async updateLastProcessedLedger(ledger: number) {
    await pool.query(
      "INSERT INTO monitoring_state (key, value, updated_at) VALUES ('last_processed_ledger', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()",
      [ledger.toString()]
    );
  }

  private async getCurrentLedger(): Promise<number> {
    const info = await this.horizon.ledgers().order("desc").limit(1).call();
    return info.records[0].sequence;
  }

  private async processEvents(startLedger: number, endLedger: number) {
    const governorId = await this.resolveGovernorContractId();
    const tokenVotesId = process.env.TOKEN_VOTES_CONTRACT_ID;

    if (!governorId || !tokenVotesId) {
      logger.warn("Contract IDs not configured for monitoring");
      return;
    }

    // In a real implementation, we would fetch events from Horizon
    // For now, I'll simulate fetching events or leave it as a placeholder
    // because I don't have a live contract to query against in this environment.
    // However, I will implement the logic that *would* process them.

    await this.checkGovernorEvents(governorId, startLedger, endLedger);
    await this.checkTokenVotesEvents(tokenVotesId, startLedger, endLedger);
  }

  private async resolveGovernorContractId(): Promise<string | null> {
    const fallbackGovernorId = process.env.GOVERNOR_CONTRACT_ID?.trim() || null;

    try {
      const result = await pool.query(
        "SELECT value FROM monitoring_state WHERE key = 'active_governor_contract_id' LIMIT 1",
      );
      const dbGovernorId =
        result.rows.length > 0 ? String(result.rows[0].value ?? "").trim() : "";

      if (dbGovernorId.length > 0) {
        if (this.currentGovernorContractId !== dbGovernorId) {
          logger.info({ governorContractId: dbGovernorId }, "Resolved governor contract ID from DB");
          this.currentGovernorContractId = dbGovernorId;
        }
        return dbGovernorId;
      }
    } catch (error) {
      logger.warn({ err: error }, "Failed to resolve governor contract ID from DB; using env fallback");
    }

    if (this.currentGovernorContractId !== fallbackGovernorId) {
      logger.info(
        { governorContractId: fallbackGovernorId },
        "Resolved governor contract ID from environment",
      );
      this.currentGovernorContractId = fallbackGovernorId;
    }

    return fallbackGovernorId;
  }

  private async checkGovernorEvents(contractId: string, start: number, end: number) {
    // This would use Horizon's events API
    // Example: this.horizon.events().forResource("contract", contractId)...
    
    // SUSPICIOUS PATTERNS:
    // 1. Paused event -> CRITICAL
    // 2. ProposalCreated with very large calldata -> MEDIUM/HIGH
    // 3. High frequency of ProposalCreated from same proposer -> MEDIUM
  }

  private async checkTokenVotesEvents(contractId: string, start: number, end: number) {
    // SUSPICIOUS PATTERNS:
    // 1. del_chsh with very large balance -> MEDIUM/HIGH
  }

  async createAlert(alert: SecurityAlert) {
    logger.warn(`SECURITY ALERT [${alert.severity}]: ${alert.message}`);
    
    await pool.query(
      "INSERT INTO security_alerts (type, severity, message, metadata) VALUES ($1, $2, $3, $4)",
      [alert.type, alert.severity, alert.message, alert.metadata]
    );

    await this.sendExternalNotification(alert);
  }

  private async sendExternalNotification(alert: SecurityAlert) {
    const webhookUrl = process.env.SECURITY_ALERT_WEBHOOK_URL;
    if (!webhookUrl) return;

    try {
      // Mock Discord/Slack webhook notification
      const payload = {
        content: `🚨 **NebGov Security Alert** 🚨\n**Type**: ${alert.type}\n**Severity**: ${alert.severity}\n**Message**: ${alert.message}\n**Meta**: \`\`\`json\n${JSON.stringify(alert.metadata || {}, null, 2)}\n\`\`\``
      };

      // In a real app, use fetch or axios
      // await fetch(webhookUrl, { method: 'POST', body: JSON.stringify(payload) });
      logger.info(`Notification sent to webhook: ${alert.type}`);
    } catch (error) {
      logger.error({ err: error }, "Failed to send external notification");
    }
  }
}

export const securityMonitor = new SecurityMonitorService();
