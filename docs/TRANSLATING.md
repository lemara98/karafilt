# Helping Karafilt work in your language

Karafilt is a free karaoke tool: it removes the vocal from whatever tab is
playing music and shows time-synced lyrics next to it. It is donation-funded,
open source, and built by one person, so the parts that need a native speaker
are the parts that are still weakest.

You do **not** need to write code to help. Most of what is asked for here is
reading a paragraph and saying "no one says it that way".

---

## What we translate, and what we don't

**The extension's interface stays in English.** That is a deliberate choice,
not laziness. A half-translated interface that drifts out of date with every
release is worse than a consistent English one, and the interface is about
twenty words wide ("Start Filtering", "Mode", "Party"). The effort goes where
language actually blocks people:

| Needs your language | Why |
|---|---|
| **Song matching** | A Hindi or Thai or Chinese title has to be recognised as a song title before any lyrics can be found. |
| **Chrome Web Store listing** | This is how people find Karafilt at all. It is searched and read in the local language. |
| **Marketing copy** (promo reel captions, posts) | Same reason. |
| **Lyrics coverage** | Word-by-word timing comes from karalyr.com's request queue - see the last section. |

Everything in that table is drafted with machine translation first and then
**must be read by a native speaker before it is published**. If you are that
speaker, that is the single most valuable thing you can do here.

---

## 1. Reviewing the translated texts (no code)

The drafts live in [`docs/store-listings/`](./store-listings/) - one file per
language, each marked with a review status at the top.

What to look for, in order of importance:

1. **Anything that is simply wrong or unintelligible.** Machine translation
   fails hardest on "vocal removal", "side panel" and "word-by-word", because
   they are product jargon.
2. **The words a real person would search for.** In most of these markets
   people search using English or half-English terms ("karaoke", "minus one",
   "instrumental", "lirik", "beat"). Tell us which term wins in yours - that
   matters more than elegant prose, because store search runs on it.
3. **Register.** Karafilt's English is plain and friendly, never corporate.
   Formal-register machine output usually needs to come down a notch.
4. **Script and diacritics.** Vietnamese tone marks, Devanagari conjuncts and
   Traditional vs Simplified Chinese all get mangled by copy-paste pipelines.

Send corrections however is easiest: a pull request editing the file, a GitHub
issue with the corrected text pasted in, or an email. Rewriting a sentence
entirely is welcome - a translation that reads like a translation is a bug.

Hard limits to respect, imposed by the Chrome Web Store:

- **Name:** 45 characters. Keep "Karafilt" in it, untranslated.
- **Summary:** 132 characters, one sentence, no line breaks.
- **Description:** no length problem in practice.
- Never promise anything the product does not do - the store rejects listings
  over this, and it is dishonest anyway.

---

## 2. Teaching Karafilt your market's title conventions (small code change)

Every music market decorates YouTube titles differently, and the decoration has
to be stripped before the song can be matched:

```
Kesariya - Full Video Song | Brahmastra | Arijit Singh     (India)
Em Của Ngày Hôm Qua | OFFICIAL MV | Sơn Tùng M-TP          (Vietnam)
【周杰倫 Jay Chou】稻香 (官方完整版MV)                        (Taiwan)
Lirik Lagu Hati-Hati di Jalan - Tulus (Video Lirik)        (Indonesia)
```

Those patterns live in one place: the **per-market noise blocks** at the bottom
of `SUFFIX_PATTERNS` in
[`shared/song-match.js`](../shared/song-match.js#L156) (search for
"Per-market noise"). One block per market, each commented.

The rule for adding to it:

1. Add a real, verifiable row to [`test/corpus.json`](../test/corpus.json)
   first - an actual video title, plus the artist and track it should resolve
   to and the approximate duration:

   ```json
   {
     "rawTitle": "Kesariya - Full Video Song | Brahmastra | Arijit Singh",
     "trueArtist": "Arijit Singh",
     "trueTrack": "Kesariya",
     "approxDurationSec": 268
   }
   ```

2. Then add the pattern that makes it pass.
3. Run `node --test "test/*.test.mjs"`. The corpus is a regression suite: your
   pattern must not break any existing row, in any market.

**Never invent corpus rows.** They are the proof that matching works; a made-up
title proves nothing. Copy a title you have actually seen on YouTube.

Even without touching code, a list of "titles in my country that Karafilt gets
wrong" pasted into an issue is directly usable - each line becomes a corpus
row.

### The word for "lyrics"

When Karafilt can't find lyrics it offers a Google search, and that search uses
the song's own language, chosen by script in
[`sidepanel/sidepanel.js`](../sidepanel/sidepanel.js#L50) (`गाने के बोल`,
`เนื้อเพลง`, `歌詞`, `lời bài hát`). If the term for your language is wrong,
or a language is missing, say so - it is a one-line fix.

Note it keys off the **song's** script, not your interface language, so a Hindi
song searches in Hindi even for a user browsing in English.

---

## 3. Getting lyrics for your language into the database

Word-by-word timing comes from [karalyr.com](https://karalyr.com), the open
karaoke lyrics database Karafilt reads from. Coverage there is
**demand-driven**: songs get timed because people request them, not because
anyone decided your language matters less.

So the loop that actually grows coverage is:

1. Play the song with Karafilt open while signed in. If it has no word timing,
   it is added to the request queue automatically. Duplicate requests count as
   votes, so a group of people asking for the same song moves it up.
2. Watch your language's shelf fill up at
   `https://karalyr.com/library?lang=hi` (swap in your code: `hi`, `vi`, `id`,
   `tl`, `th`, `zh`).

If a language works badly enough that requests come back broken - words in the
wrong place, or the whole line lighting up at once - report it. Thai, Khmer and
Lao are the known-hard cases, because those scripts are written without spaces
between words and the timing has to guess where the words are.

---

## Which languages are being worked on

| Language | Song matching | Word timing | Store listing |
|---|---|---|---|
| Hindi (`hi`) | yes | yes | draft, needs review |
| Vietnamese (`vi`) | yes | yes | draft, needs review |
| Indonesian (`id`) | yes | yes | draft, needs review |
| Filipino / Tagalog (`tl`) | yes | yes | draft, needs review |
| Chinese, Traditional (`zh`) | yes | yes, per character | draft, needs review |
| Thai (`th`) | yes | word-level, unverified | not started |
| Khmer (`km`), Lao (`lo`) | partly | line-level only | not started |
| Tamil, Telugu, Punjabi, Bengali | partly | yes | not started |

Any language written in a script Karafilt can render will work - this table is
about how well it is tuned, not whether it functions.

## Contact

- Issues and pull requests: this repository (see
  [`CONTRIBUTING.md`](../CONTRIBUTING.md); contributions are MIT-licensed).
- Prefer email: mile.knezevic98@gmail.com

There is no money in Karafilt - it is free, has no ads and no paid tier, and
takes donations only - so there is nothing to pay a translator with. Credit in
the changelog and the store listing is offered instead, if you want it.
