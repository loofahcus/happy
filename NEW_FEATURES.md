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

---

## 2. Verbose Mode: Show Model Thinking Content

### Problem

Upstream silently drops every assistant message marked `isThinking`. Users investigating why a turn took the path it did have no way to see the model's reasoning blocks — they're not even toggleable.

### Design

Add a `verbose` boolean setting (default `false`) and gate the existing `if (props.message.isThinking) return null;` on it. When verbose is on, thinking blocks render in the same `agentMessageContainer` but at `opacity: 0.35` so they read as visually distinct from the actual response. Timestamps are still suppressed for thinking blocks (they fire constantly during a turn — adding timestamps would be noise).

### Files changed

| File | Change |
|---|---|
| `packages/happy-app/sources/sync/settings.ts` | Adds `verbose: z.boolean()` to `SettingsSchema` and default `false`. |
| `packages/happy-app/sources/components/MessageView.tsx` | `AgentTextBlock` now reads `useSetting('verbose')`; thinking blocks render with reduced opacity instead of being dropped when verbose is on. |
| `packages/happy-app/sources/app/(app)/settings/features.tsx` | Adds the **Verbose Mode** toggle in Settings → Features (chatbox-ellipses icon). |
| `packages/happy-app/sources/text/_default.ts` | New i18n keys `settingsFeatures.verbose` + `settingsFeatures.verboseSubtitle`. |
| `packages/happy-app/sources/text/translations/{en,es,ca,it,ja,pl,pt,ru,zh-Hans,zh-Hant}.ts` | Same keys translated in all 10 languages. |

### Notes

- Stacks naturally on the timestamp work (#1): thinking blocks intentionally do **not** get a timestamp because Claude emits many rapid thinking segments per turn.
- Port of fork commit `713d0f03`. Diff applies cleanly on top of upstream's restructured `MessageView`.
