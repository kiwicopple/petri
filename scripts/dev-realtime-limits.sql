-- Raise local Realtime tenant rate limits (15 Hz x N players with fanout exceeds defaults).
-- Column names verified against the local stack's `_realtime.tenants`.
update _realtime.tenants set
  max_events_per_second          = 10000,
  max_concurrent_users           = 10000,
  max_joins_per_second           = 5000,
  max_channels_per_client        = 1000,
  max_presence_events_per_second = 10000,
  max_bytes_per_second           = 100000000,
  max_payload_size_in_kb         = 3000;
