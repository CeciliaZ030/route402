# Routex402 — brand reference

## Name & tagline
**Routex402** — "Verified reputation for AI agent payments"

The name references HTTP 402 (Payment Required), the status code the x402 protocol
is built on — the same mechanism this project's payment flow uses.

## Logo
Two dots — solid purple, solid green — sitting inside a rounded square (in-app) or
standing alone (profile picture / small placements). Represents two agents
(buyer, seller) connected by a transaction.

- Full lockup (mark + wordmark + tagline): use in headers, banners, pitch decks
- Mark alone: use for favicons, avatars, anywhere space is tight

## Colors

| Name | Hex | Use |
|---|---|---|
| Background | `#1C1F24` | Page background |
| Surface | `#24282E` | Cards, containers |
| Surface (raised) | `#2B2F36` | Nested elements, hover states |
| Purple | `#9945FF` | Primary accent — Solana brand purple |
| Green | `#14F195` | Secondary accent — Solana brand green |
| Text primary | `#F5F5F7` | Headings, body text |
| Text secondary | `#8A8F98` | Captions, muted labels |
| Text muted | `#5F636B` | Timestamps, least-emphasis text |
| Border | `#33373E` | Card borders, dividers |

Purple and green are Solana's own brand colors — deliberately reused here to signal
"built on Solana" at a glance, not arbitrary choices.

## Typography
- **Headings/wordmark**: DejaVu Sans Bold (or Space Grotesk / Inter in-browser,
  where available — DejaVu Sans is the fallback used for static image assets)
- **Body/UI text**: DejaVu Sans / Inter / system sans-serif
- **Numbers/addresses**: monospace, for legibility of wallet addresses and amounts

## Voice
Plain, functional, slightly technical — this is infrastructure, not a consumer
product. Avoid hype language ("revolutionary," "game-changing"). Prefer precise
claims ("real transaction, verified on Solscan") over vague ones ("powerful,"
"seamless").

## Assets in this kit
- `favicon.svg` / `favicon.ico` / `favicon-32.png` / `favicon-16.png` — site favicon
- `apple-touch-icon.png` — iOS home-screen icon
- `x-profile-picture.png` (512×512) — square avatar for X, LinkedIn, Discord, etc.
- `x-banner.png` (1500×500) — X header image, exact recommended size
- `og-image.png` (1200×630) — link preview image for Discord/Slack/Twitter/LinkedIn
- `og-image.svg` — source file for the above, editable if the pitch changes

## Links
- Live demo: https://route402.onrender.com
- Repo (private): https://github.com/msurfx/route402
- On-chain program: `6pp5jDS23FBcwtqe8pTiBJw3osyHZQPENr9bK3P62vjt` (Solana devnet)
