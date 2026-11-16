# 200 Club

Hold'em for friends. 200 chips to sit down. A laptop-first poker web app with table codes,
an automatic dealer that runs on the server, ratings, and a live leaderboard.

- **Ratings:** everyone starts at 1200. After each hand, winners are scored against losers,
  scaled by the size of the pot (50 big blinds or more counts in full), Elo-style.
  Beating higher-rated players earns more. Ratings never reset.
- **During a game:** the right panel shows this table's standings (rating, last change,
  net chips), the global leaderboard, and a hand-by-hand log.
- **Keyboard:** F fold, C or Space check/call, R raise, arrow keys adjust, Enter confirms, Esc backs out.

## Put it online (about 10 minutes, all in the browser)

1. **GitHub:** create a new repository (for example `200-club`). On its page click
   "uploading an existing file", drag in everything from this folder
   (`api`, `lib`, `public`, `package.json`, `vercel.json`, `README.md`), and commit.
2. **Vercel:** sign in at vercel.com with GitHub, click **Add New → Project**, import
   the repository, and click **Deploy**. No settings to change.
3. **Database:** in the project, open the **Storage** tab, create an **Upstash for Redis**
   database on the free plan, and connect it to the project.
4. **Redeploy:** go to **Deployments**, open the menu on the latest one, and click
   **Redeploy** so the game picks up the database.
5. Open your `.vercel.app` link and send it to your friends.

If the page says the server isn't connected to its database, step 3 or 4 didn't finish.

### Optional
- **New season for net chips:** add an environment variable `ADMIN_PIN` (any number) in
  Settings → Environment Variables, then redeploy. A reset button appears on the leaderboard.
  It zeroes net chips only; ratings carry over.
- **Database from upstash.com instead:** set `UPSTASH_REDIS_REST_URL` and
  `UPSTASH_REDIS_REST_TOKEN` in Vercel's environment variables.

## Costs
Vercel's free Hobby plan covers this. Upstash's free tier is 500K database commands a month;
a 3-hour night with four players uses very roughly 70K, so that's several game nights a month.
Past that, Upstash pay-as-you-go is $0.20 per 100K commands, so cents per night.

## How it works
- `public/index.html` is the whole app. It polls `/api/game` about once a second.
- `api/game.js` is the dealer. It shuffles, deals, runs turn timers, settles pots and
  only ever sends each player their own hole cards.
- `lib/engine.js` holds the poker rules (hand ranking, betting, side pots).
- Players are anonymous: each browser gets a random secret key, so clearing site
  data or switching phones makes you a new player.
