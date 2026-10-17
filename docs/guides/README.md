# Player and playtest guides

Player-facing docs for the Oct 2026 playtests ([../PLAYTESTS.md](../PLAYTESTS.md)). The Markdown files are the source of truth; the other files are the same content shaped for where they get published.

| File | What | Published to |
|---|---|---|
| [USER-GUIDE.md](USER-GUIDE.md) | Player guide: start, toys, controls (mouse, touch, gamepad), play together, trouble | GitHub repo docs; site `/learn/guide/` |
| [PLAYTEST-REMOTE.md](PLAYTEST-REMOTE.md) | Remote multiplayer playtest on itch.io: setup, session, questions | GitHub; site `/learn/playtest-remote/`; linked from the email |
| [PLAYTEST-LOCAL.md](PLAYTEST-LOCAL.md) | Local playtest on Windows with two gamepads, with a facilitator sheet | GitHub; site `/learn/playtest-local/`; linked from the email |
| [itch-page.html](itch-page.html) | itch.io page description (HTML for itch's editor) | itch.io restricted page |
| [email-remote.txt](email-remote.txt) | Plain-text invitation for the remote playtest | Email |
| [email-local.txt](email-local.txt) | Plain-text invitation for the local playtest | Email |
| [site/playtest.md](site/playtest.md) | Public "take part" page (Starlight frontmatter, site-relative links) | Project website, once `apps/site` exists ([PUBLISHING.md](../PUBLISHING.md) §6) |

## Placeholders

Every file uses `{{NAME}}` placeholders. Fill them per session:

| Placeholder | Example |
|---|---|
| `{{ITCH_URL}}` | `https://<user>.itch.io/cosmic-playground` |
| `{{ITCH_PASSWORD}}` | the page password (never commit it) |
| `{{BUILD_ID}}` | the `--userversion` of the frozen build, e.g. `0.1.0+a3d2fcd.7f3e` |
| `{{DATE_TIME}}`, `{{DATE_SHORT}}`, `{{DEADLINE}}` | `Sat 24 Oct, 10:00 PDT / 19:00 CEST` |
| `{{HOST_NAME}}`, `{{SENDER_NAME}}`, `{{FIRST_NAME}}` | |
| `{{FEEDBACK_CONTACT}}` | an email address or form link |
| `{{VOICE_CALL}}` | Discord / Zoom link |
| `{{GUIDE_URL_REMOTE}}`, `{{GUIDE_URL_LOCAL}}` | the GitHub or site URL of the matching guide |
| `{{REPO_URL}}`, `{{BRANCH}}` | `https://github.com/asyncopatedsoul/cosmic-playground`, the default branch |

## Keeping them true

- The gamepad table comes from [PLAYTESTS.md](../PLAYTESTS.md) §3.2; once `src/controllers/gamepad-map.ts` exists it is the source, and these tables must match it.
- Anything marked *new in this build* describes work from PLAYTESTS.md. Don't send the emails until the build with that work is pushed and its build id is known.
- The repo is public: keep filled-in copies (password, itch URL, tester names) out of it. Fill placeholders in the email client or itch editor, not here.
