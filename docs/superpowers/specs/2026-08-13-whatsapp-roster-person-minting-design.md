# WhatsApp roster Person minting

## Goal

Create or link Person entities from participant observations in enabled WhatsApp groups, even when WhatsApp provides no human-readable name.

## Behavior

- Run only for WhatsApp groups with `index_enabled = 1`.
- Resolve an existing live Person by normalized phone or WhatsApp LID before creating anything.
- When no Person matches, create an external Person with inferred provenance.
- Choose the initial name in this order: safe human-readable participant name, phone number, WhatsApp LID.
- Store every available phone and LID as identity contact points on the Person.
- When a safe name arrives later, replace a phone/LID fallback canonical name. If the Person already has a human-readable name, retain it and add the new name as an alias.
- Repeated and overlapping roster refreshes must converge on one Person.
- Do not change Slack behavior or the WhatsApp chunk-only LLM no-mint policy.

## Placement

Extend the existing WhatsApp participant observation projection. Keep identity reconciliation in a focused repository helper invoked from `refreshParticipants` after the observation is durably reconciled. The helper performs matching, creation, contact-point upserts, and safe name enrichment inside the same transaction.

## Safety

- Disabled groups never mint or update Persons.
- Phone and LID are identity keys; fallback display names are never used as the primary dedup key.
- Ambiguous observations that point to different existing Persons do not merge them automatically.
- Stale observations cannot overwrite fresher identity or naming state.

## Verification

Add SQLite and Postgres integration coverage for enabled-group creation, disabled-group no-op, phone/LID fallback names, later human-name upgrade, repeated refresh idempotency, partial-to-complete identity convergence, and conflicting existing identities.
