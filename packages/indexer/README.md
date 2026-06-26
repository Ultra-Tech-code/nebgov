# NebGov Indexer

The NebGov indexer consumes on-chain governance events and exposes a REST API for historical governance analytics.

## Run Locally

```bash
pnpm --filter @nebgov/indexer run migrate
pnpm --filter @nebgov/indexer run dev
```

The service defaults to port `3001` unless `PORT` is set.

## Key Endpoints

- `GET /health` - indexer health and lag metrics
- `GET /stats` - governance aggregate statistics
- `GET /proposals` - proposal list (offset or cursor pagination)
- `GET /proposals/:id` - single proposal
- `GET /proposals/:id/votes` - votes for a proposal
- `GET /delegates` - delegation leaderboard
- `GET /profile/:address` - proposer/voter profile
- `GET /wrapper/deposits` - wrapper deposit history
- `GET /wrapper/withdrawals` - wrapper withdrawal history
- `GET /treasury/transfers` - treasury transfer history
- `GET /config-history` - paginated governor config change history
- `GET /upgrade-history` - paginated governor upgrade history

## Config History

`GET /config-history` returns governance parameter updates indexed from `ConfigUpdated` events.

Query params:

- `limit` (optional, default `20`, max `100`)
- `offset` (optional, default `0`)

Response shape:

```json
{
  "data": [
    {
      "id": 42,
      "ledger": 987654,
      "old_settings": { "voting_delay": 10 },
      "new_settings": { "voting_delay": 20 },
      "ledger_closed_at": "2026-06-01T12:00:00.000Z",
      "created_at": "2026-06-01T12:00:03.000Z"
    }
  ],
  "pagination": {
    "limit": 20,
    "offset": 0,
    "hasMore": false
  }
}
```
