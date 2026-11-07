import { Type, type Static } from '@sinclair/typebox';
import {
  CampaignId,
  Count,
  EventId,
  Ms,
  SchemaVersion1,
  SessionId,
  Ulid,
  UnixMs,
} from '../common.ts';

/**
 * Envelope of one Foundry observation (one line of `foundry.jsonl`, T16).
 *
 * Raw timing only: `observed_at_unix_ms` is the writer client's wall clock. Mapping to the session
 * timeline is a separate alignment artifact (T18); the envelope is never rewritten (ADR-003).
 * `payload` is system-specific (T17) and is validated by the adapter, not here.
 */
export const FoundryEventSchema = Type.Object(
  {
    schema_version: SchemaVersion1,
    event_id: EventId(),
    capture_id: Ulid({ description: 'One designated-writer capture session (T16).' }),
    seq: Count({ description: 'Monotonic per capture_id; event_id = fvtt:<capture_id>:<seq>.' }),
    campaign_id: CampaignId(),
    session_id: SessionId(),
    world_id: Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' }),
    writer_user_id: Type.String({
      pattern: '^[A-Za-z0-9]{16}$',
      description: 'Foundry user document ID of the designated writer.',
    }),
    foundry_version: Type.String({ pattern: '^[0-9]+(?:\\.[0-9]+){0,2}$' }),
    system_id: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,31}$' }),
    system_version: Type.String({ minLength: 1, maxLength: 32 }),
    type: Type.String({
      pattern: '^[a-z0-9-]+(?:\\.[a-z0-9-]+)+$',
      maxLength: 64,
      description: 'Namespaced event type, e.g. core.roll, core.scene, pf2e.condition.',
    }),
    observed_at_unix_ms: UnixMs(),
    clock_uncertainty_ms: Ms(),
    payload: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);
export type FoundryEvent = Static<typeof FoundryEventSchema>;
