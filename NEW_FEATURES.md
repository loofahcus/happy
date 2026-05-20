# New Features — Implementation Notes

This document records each feature we re-implement on top of `upstream/main`, including the problem it solves, the design, and the files changed.

---

## 1. Show Date Alongside Timestamp for Non-Today Messages

### Problem

Upstream renders no per-message timestamp. Old conversations are timeless, so when scrolling far up there is no way to tell whether a message is from today or last week.

### Design

Add a small right-aligned timestamp under each user bubble and a left-aligned one under each agent message. Format depends on the day:

| Date | Format |
|---|---|
| Today | `HH:MM` (24h) |
| Other days | `Mon DD HH:MM` (e.g. `Mar 22 14:30`) |

Same logic also applies to the `limit-reached` agent event so quota windows remain unambiguous across day boundaries.

### Files changed

| File | Change |
|---|---|
| `packages/happy-app/sources/components/MessageView.tsx` | Adds `formatMessageTime()` helper. Renders `<Text style={styles.userTimestamp}>` after both the slash-command chip and the regular bubble inside `UserTextBlock`. Renders `<Text style={styles.agentTimestamp}>` after the markdown in `AgentTextBlock`. Inlines the same logic into `AgentEventBlock`'s `formatTime` for `limit-reached`. Adds `userTimestamp` + `agentTimestamp` styles; reduces `userMessageBubble`/`commandChip` `marginBottom` from 12 to 4 so the timestamp sits close beneath. |

### Notes / deviations from upstream commit `f5558f46`

- Re-implemented on top of upstream's restructured `UserTextBlock` (slash-command chip path, fork-from-message `Pressable` long-press) — fork's diff didn't apply cleanly.
- Both render paths inside `UserTextBlock` now carry the timestamp (chip + bubble); the fork only had the single bubble path because the chip didn't exist yet.
