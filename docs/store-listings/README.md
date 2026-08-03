# Localized Chrome Web Store listings

One file per language. These are **drafts**: machine-translated by Claude from
`docs/STORE_LISTING.md`, not yet read by a native speaker. The review process
and what to look for are in [`../TRANSLATING.md`](../TRANSLATING.md).

**Do not publish a listing whose status line still says `NEEDS NATIVE REVIEW`.**
A listing is the first impression in a market where nobody knows this product;
an obviously machine-translated one costs more trust than English would.
English is the safe default until a human has read the file.

## Status

| File | Language | CWS locale code | Status |
|---|---|---|---|
| [`hi.md`](./hi.md) | Hindi | `hi` | NEEDS NATIVE REVIEW |
| [`vi.md`](./vi.md) | Vietnamese | `vi` | NEEDS NATIVE REVIEW |
| [`id.md`](./id.md) | Indonesian | `id` | NEEDS NATIVE REVIEW |
| [`fil.md`](./fil.md) | Filipino | `fil` | NEEDS NATIVE REVIEW |
| [`zh_TW.md`](./zh_TW.md) | Chinese (Traditional) | `zh_TW` | NEEDS NATIVE REVIEW |

Thai is deliberately absent: word-level Thai timing has not passed its quality
check yet, so there is nothing honest to advertise there.

## How to publish one

Chrome Web Store dashboard -> the item -> **Store listing** -> the language
dropdown at the top -> **Add language**. Name, summary, description and
screenshots are stored per language; everything else (permissions, privacy
answers, pricing) is global. No code change, no new upload, no review of the
package - so a listing can be added or corrected at any time, independent of
version releases.

Limits enforced by the store: name 45 characters, summary 132 characters.
Each file states its own counts; re-check them after editing.

## Conventions used in the drafts

- **"Karafilt" is never translated or transliterated.** It is the name people
  type into store search.
- Product jargon that people search for in English stays in English or is
  glossed: "karaoke", "minus one", "beat", "instrumental", "lyrics".
- The description states plainly that the extension's own interface is in
  English. Being surprised by that after installing is worse than knowing.
- No claim appears here that isn't in the English listing.
