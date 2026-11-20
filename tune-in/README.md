# 🎯 Tune In — a 2-player mind-reading dial game

1. The **clue-giver** secretly sees a target on a dial and a spectrum (e.g. *Cold ↔ Hot*), then gives a one-line clue.
2. The **guesser** drags the dial to where they think the clue belongs.
3. Reveal: bullseye = 4, close = 3, near = 2. Swap roles each round, score as a team.

## Two ways to play
- **One phone:** pass the device back and forth. Works by just opening `index.html`.
- **Online (two phones):** one player creates a room and shares the 4-letter code or link. The other joins.
  Each phone only sees what its player should see. The guesser's needle moves live on the clue-giver's screen.

## Files
- `index.html`: the game page (both modes)
- `cards.js`: the spectrum cards, shared by the page and the server
- `api/room.js`: Vercel serverless function that keeps online rooms in Redis

## Hosting on Vercel
Deploy this folder as a Vercel project, then connect an **Upstash for Redis** store to it
(Project → Storage → Create Database → Upstash for Redis, free plan) and redeploy.
The function reads `KV_REST_API_URL` / `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`).
Rooms expire after 24 hours of inactivity.
