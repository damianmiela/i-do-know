# What to test before merging

Everything on `main` that hasn't been tested on Damian's PC yet (Phases 3 re-audit fixes to 9.5; the first test round covered up to 6.6, so after pulling the new version the quickest route is sections 9 to 15 first, then sections 2–5 again). Tick items as you go; anything that looks wrong: note it here and tell Claude. Claude adds a section for every new phase.

You need: the Windows PC, one or two phones on the **same Wi-Fi**, ideally a second screen or TV for the big screen. About 45–60 minutes.

## 0. Setup (PowerShell, local, in the project folder)

```powershell
npm ci
npm run check
npm run build
$env:HOST = "0.0.0.0"; npm start
```

- [ ] `npm run check` passes (all tests green).
- In a second PowerShell window: `ipconfig` → note the **IPv4 address** (e.g. `192.168.1.23`). Below, `<IP>` means that address.
- Windows may ask whether Node may use the network: allow it for **private** networks.
- For a fresh start at any time: stop the server (Ctrl+C), delete the `data` folder, start again. (Not needed after pulling 6.7: the game saved by the first test still loads; joining then starts **closed**.)
- Always open the host panel and the big screen at `http://<IP>:3210`, not `localhost`/`127.0.0.1`: the QR code uses the address the page was opened at (both warn if it's localhost).

## 1. Login and pages (PC browser)

- [ ] `http://<IP>:3210` → the login page (instructions for guests in 5 languages, "Organizer" form below).
- [ ] Wrong password → "Wrong password." Right password → the **host panel**.
- [ ] "Open the big screen" (host panel, Big screen) opens `/screen`; press **F** for full screen, the mouse pointer hides after 3 s.
- [ ] Log out, open `http://<IP>:3210/screen` → login → after logging in you land back on the **big screen** (not the host panel).

## 2. Joining on a phone

- [ ] Host panel → Joining: **Open joining** (it starts closed, see section 9).
- [ ] Scan the QR code on the big screen with the phone camera → language choice (the phone's language pre-selected).
- [ ] Pick a language → "Find your name": type 2 letters of a name from the example list (e.g. `luk`, `nur`, `jur`), accents don't matter.
- [ ] Tap a name → "Is this you?" → Yes → waiting room ("You're in!"). The big screen's guest count ticks up.
- [ ] "Not you? Change name" → asks "Give back this name?" → Yes → back to the name search.
- [ ] Second phone: the name taken by the first phone shows "Already taken".
- [ ] Flag button at the top: change the language any time.
- [ ] Host panel → Guests: the joined guests show "online"; release one → that phone goes back to the name search.

## 3. Warm-up round

- [ ] Host panel (waiting room): **Start warm-up** → phones and screen show the practice question with a "Practice round" badge.
- [ ] Answer on the phone → the question stays, your answer gets a ✓, "Your answer is saved", "Answered in … s" and "N of M have answered".
- [ ] Big button: Reveal → Top 10 → next practice question … → "Show the practice results" → the podium place by place (like the real quiz, with the "Practice round" badge) → "Practice done! The real quiz starts soon." → "End the warm-up" → everyone back in the waiting room. The real scores are still 0 and nothing appears in Past games.
- [ ] Start the warm-up again: it can be played again.

## 4. The quiz (host panel + big screen + phones)

- [ ] Big button "Start the quiz" asks first (shows how many joined) → question 1 on the screen: the text first, then the answers one by one, then the clock.
- [ ] Phones show the question at once; tap an answer → the others fade, the countdown keeps running. "Tap once" hint on question 1.
- [ ] **Double-tap** the big button quickly: only ONE step happens (e.g. only the reveal, not the Top 10 too).
- [ ] Pause / Resume / +10 seconds work (screen shows "Paused", the countdown stops and continues). Double-tap Pause: it stays paused. Double-tap +10 s: only 10 s are added.
- [ ] Reveal: the bars grow and count up, wrong answers dim, the right answer lifts and glows gold. Phones: "Correct!" with points counting up, or "Not this time" with the right answer.
- [ ] Top 10 after every question. **After question 1 nobody has an arrow** (▲/▼). After question 2: the list opens in the old order and slides into the new one, scores count up, arrows appear.
- [ ] Skip question (asks first) → the next question gets its entrance animation too.
- [ ] Lock one phone for more than 10 s during a question, unlock → it's back in the game at once, score intact.
- [ ] Don't answer on one phone until the time runs out → "Time's up!".
- [ ] After the **last** question: phones don't show places ("Look up at the big screen for the podium!").
- [ ] Podium: "Reveal 3rd place" / "2nd" / "the winner" (the button says which place, or "nobody is 3rd" when fewer scored). The winner gets confetti. Phones show their final place only after the winner.
- [ ] Reload the big screen in the middle of the podium: it shows the current state, nothing replays.
- [ ] Restart quiz (asks first) → waiting room, scores 0, guests still joined.
- [ ] Two hosts: open the host panel on the laptop AND on your phone; tap the big button on both at the same moment → only one step happens, the other says "Already done".

## 5. Guests, joining, emergencies (host panel)

- [ ] Guests: search a name (accents don't matter), statuses (online / joined, not connected / not joined).
- [ ] Add a missing guest; add the same name again → asks "a different person with the same name?".
- [ ] Joining → "Release recent names…" → "the last 15 min": those phones go back to the name search (joining open: they pick their name again at once).
- [ ] Big screen language: switch EN/PL/ES/CA/DE in the host panel → the screen changes at once; phones keep their own language.

## 6. Saving and restarting

- [ ] During a question: stop the server (Ctrl+C) and start it again (`npm start`) → phones and screen reconnect by themselves, the game continues where it was. Host panel shows "saved N s ago".

## 7. Looks and motion

- [ ] Big screen on the TV/projector: readable from the back of the room; animations smooth (no stutter).
- [ ] Windows "Show animations" off (Settings → Accessibility → Visual effects): the screen works without animations.
- [ ] Host panel on the phone: tabs, the big button stays at the bottom while scrolling.

## 8. Question editor (Phase 6.6)

In the waiting room (not during the quiz or the warm-up). Laptop: the Questions panel; phone: the Questions tab.

- [ ] "+ Add a question": type the question and 4 answers in **EN only**, mark the right one, Save → the list shows "missing: PL, ES, CA, DE"; the big button says "Complete the translations first".
- [ ] Edit it: click PL / ES / CA / DE (the red dots show what's missing), fill everything, Save → the big button says "Start the quiz" again.
- [ ] Preview: the big screen and a phone in small frames; "Show the reveal" shows the right answer.
- [ ] Photo question: type "Photo question", "Choose a photo…" with a big photo from the PC → a thumbnail appears; `content\photos` has a new `photo-….webp` of a few hundred KB at most.
- [ ] Bride or groom: starts with the two names from `content/event.json`; only 2 answers.
- [ ] ↑ / ↓ reorder, Copy, Delete (asks first). `content\questions.json` changes; `content\questions.prev.json` is the version before.
- [ ] Warm-up tab: the same for the practice questions.
- [ ] Start the warm-up → the editor is locked ("only in the waiting room"); after "End warm-up" it's back.
- [ ] Restart the server (Ctrl+C, `npm start`): the edited questions are still there.
- [ ] A question text longer than ~150 letters in one language → the "Long text" note appears; the preview shows it smaller.

`content\questions.json` and `content\photos` are private (git-ignored): they never go to GitHub.

## 9. After the first test (Phase 6.7)

- [ ] **Warnings:** the top of the host panel shows no yellow boxes for the example files any more; they are under Big screen → "Setup notes (2)" (click to open).
- [ ] **Joining closed** (the start state): the host panel's Joining box is amber, "Joining is closed". The big screen's lobby shows "Joining opens soon" (PL/ES/DE) instead of the QR code.
- [ ] A phone that opens `http://<IP>:3210/join` now shows **"You're a bit early!"**. Leave it open, then tap **Open joining** on the host panel → the phone goes on to the language choice **by itself**, and the big screen shows the QR code.
- [ ] Under the QR code: the link as large text, `<IP>:3210/join`. Type it into a second phone's browser → it works the same as scanning (Chrome may need `http://` in front while testing without HTTPS).
- [ ] Type only `http://<IP>:3210` on a phone (no `/join`) → it also lands in the join flow, not on the login.
- [ ] Open the host panel at `http://localhost:3210/host` once → a yellow box says phones can't use that address (the big screen at localhost says the same). Then back to `http://<IP>:3210`.
- [ ] Close joining while a phone is in the waiting room → it stays in. "Not you? Change name" then says to ask the quiz host.
- [ ] Audit 8: on a phone that opened `/join` but has **not** picked a name, `http://<IP>:3210/photos/example-baby.webp` (or any photo in `content\photos`) shows "Pick your name first"; after picking a name it opens.
- [ ] During the quiz with joining closed, a new phone opening the link shows "Joining is closed right now" (not "too early").
- [ ] **Timer:** Game panel, "Timer per question": type `30` → Set → "Timer set: 30 s per question". Also try `1:30` (= 90 s) and `5` (refused: 10 to 300). Start the quiz: the countdown starts at the new time on the screen and the phones. During the quiz the field is replaced by "Timer: … per question". `content\questions.json` has `"timeLimitSec": 30` at the top.
- [ ] Question editor: no "Time to answer" field any more; the question list shows no seconds per question.
- [ ] **Phone after answering:** the question stays, the other three answers fade, yours keeps a white frame and a ✓, the countdown keeps running to 0, below: "Your answer is saved", "Answered in 3.8 s", "1 of 2 guests have answered" (updates when the second phone answers).
- [ ] **Big screen during a question:** top left a large "1 / 2 answered" box whose gold bar fills as answers come in; top right "Lost? Scan here" with the link as text and the small QR code (hidden while joining is closed).
- [ ] Points: answer right at once → about 1000; answer right in the last seconds → about 500; wrong → 0.

## 10. Game archive (Phase 6.8)

- [ ] Play a short game to the end (tip: set the timer to 10–15 s). When the podium appears, the host panel's **Past games** panel (phone: tab "Past") lists it: date and time, players, questions, the winner. `data\games` has one new `.json` file.
- [ ] Reveal the podium and restart the quiz: still only one saved game. A warm-up played to its end is not saved.
- [ ] **Open** it: the ranking (points, correct answers); click a question → the votes per answer (✓ on the right one) and who answered what, fastest first, with time and points.
- [ ] **CSV** opens in Excel/LibreOffice with accents intact (ł, ñ, ß); **JSON** downloads the whole game.
- [ ] **Show on screen** (in the waiting room or at the podium): the big screen shows that game's Top 10 with "Past game · date" on top; a question's **Show these votes on screen** shows its vote bars. The host panel shows a yellow line with **Back to the live game**. During a question the buttons are greyed out.
- [ ] Starting the quiz or the warm-up brings the live game back on the big screen by itself.
- [ ] **Delete** asks first; the game disappears from the list and from `data\games`.
- [ ] Host panel on the phone: the tabs stay one short row (5 tabs), the Past tab fits without sideways scrolling.

- [ ] Ghost players: with your real guests.json, restart the server (Ctrl+C, `npm start`) in the waiting room: "Players joined" on the big screen and phones equals the guests who picked a name (the leftover from the example list is gone; Big screen → Setup notes says so).

## 11. Game flow and the final ranking (Phase 6.9)

- [ ] **Auto-reveal** (Game panel, on by default): with 2 phones, both answer → about 1.5 s later the answer is revealed by itself (each phone saw its ✓ first). Next question: one phone answers, the other not → the reveal comes when the time is up. The Top 10 and the next question still need your tap.
- [ ] A guest who stops answering (2 questions in a row) no longer holds up the early reveal.
- [ ] Pause during a question: nothing is revealed while paused; "+10 seconds" moves it. Switch auto-reveal off: you tap Reveal as before (the switch stays off after a server restart).
- [ ] **Full ranking:** after the winner, the big button says "Show the full ranking". The big screen shows everyone, stays 5 s at the top, scrolls slowly down (with many guests), waits 5 s, jumps back up quickly, again and again. Every phone shows the whole list with its own row in gold, scrolled into view.
- [ ] **Phones never scroll during a question:** on the smallest phone you have (and with the phone's text size turned up), a photo question with 4 answers: before answering, after answering (✓ and the three lines), paused, time's up. Everything is on the screen without scrolling; a long German question gets smaller type.
- [ ] **Remove a guest you added:** Guests → an added guest → Remove (asks first) → gone from the list; their phone goes back to the name search; during a quiz their points leave the Top 10. Guests from guests.json have no Remove button.

## 12. Question sets, overall ranking, phone leaderboard (Phase 6.10)

Your own `content\questions.json` has no sets yet: create one in the editor (below). (`questions.example.json` has a fake example set, used only when there is no `questions.json`.)

- [ ] **Phone top bar** (360 px wide phone if you have one): one line with "3 of 15" (no pill), your short name ("Anna Maria Kowalska" → "Anna K."), and the language as a flag only. Tapping the flag still opens the language choice.
- [ ] **Phone between questions:** instead of "Look at the big screen", your own row in gold in the middle, up to 3 places above and 3 below (rank, name, points, ▲▼). From question 2 on, the rows slide from the old order into the new one and the points count up, like on the big screen. First and last places: fewer rows on one side.
- [ ] **Big screen Top 10:** "1 of 15 questions" big and gold in the middle of the top, no pill. Switch the screen language: "1 z 15 pytań", "1 de 15 preguntas", "1 von 15 Fragen".
- [ ] **Warm-up podium:** see section 3.
- [ ] **Create a set:** Questions → "+ New set" → name it (e.g. "Test round") → Create → add 2 questions in its tab. "Rename set" works; the same name twice (or "Main quiz") is refused. `content\questions.json` gets a `"sets"` list.
- [ ] Play the main quiz to the end (podium). Restart quiz → waiting room: the Game panel shows "Round" with a picker (✓ on played sets) and "Show the overall ranking (1 round)".
- [ ] Pick "Test round" → the big screen's waiting room shows the round's name; "Start the quiz" plays only its 2 questions with scores starting from 0. Its podium and the full ranking are for this round only. Past games shows it with the set's name.
- [ ] **Overall ranking:** after the round's podium (or back in the waiting room) → "Show the overall ranking (2 rounds)": big screen "Overall ranking · 2 rounds" with the points of both rounds added up (scrolling loop with many guests); every phone shows the list with its own row in gold. "Hide the overall ranking" or starting a round brings the live game back. Picking another round hides it too.
- [ ] During the podium (before the winner) the "Show the overall ranking" button and "Show on screen" of past games are greyed out; after the winner they work. Hiding the overall ranking brings the podium back without new confetti.
- [ ] Back in the waiting room after a round: the restart sheet says "Back to the waiting room?"; phones say "The next round starts soon".
- [ ] "Reset overall…" asks first, then the overall ranking is gone (the rounds stay in Past games).
- [ ] Restart the server (Ctrl+C, `npm start`) in the waiting room with the set picked: the set is still picked and the overall ranking still has its rounds.
- [ ] "Delete set" (asks first) on the picked set → the Round picker goes back to "Main quiz".

## 13. Content and languages (Phase 9)

- [ ] **Warm-up:** copy the `"warmup": [ … ]` block from `content\questions.example.json` into your `content\questions.json` (or use the file Claude sent), restart, Start warm-up: "What are we celebrating today?", "Who is the groom today?" (the bride ♥ / the groom ★), "What does nobody need at a wedding?"; then the practice podium.
- [ ] **Review sheets (PowerShell, local, server stopped):** `npm run texts:export` → `content\review\ui-texts.csv` and `questions.csv`. Both open in Google Sheets (File → Import) and Excel with ł, ñ, ß intact. Reviewers fill only the "XX fixed" column of their language. The question sheet is private: share it only with the reviewers.
- [ ] **Import (test):** in `questions.csv` write something into one "PL fixed" cell, save as CSV, `npm run texts:import -- content\review\questions.csv` → "1 text(s) changed"; `npm start` → the editor shows the new text; `content\questions.prev.json` is the version before. (Undo: copy `questions.prev.json` back over `questions.json`.)
- [ ] **Favicon:** the browser tab shows the two gold hearts (login page, host panel, big screen, phone). On an iPhone "Add to Home Screen" uses them too.
- [ ] Collect mode is off: nothing about wristbands on phones (as before).

## 14. Reading time and the couple's round (Phase 9.5)

- [ ] **Reading time** (Game panel, on by default): Start the quiz → the big screen and phones show only the question ("The answers are coming…", no clock); tapping on the phone does nothing; the big button says **Show the answers**. Tap it → the answers appear on the screen and all phones at once and the countdown starts from full. Pause/+10 s appear only then. Skip works during the reading time too.
- [ ] Switch reading time off during the quiz: from the next question the answers come at once (as before).
- [ ] Reload a phone during the reading time: it shows the question without answers, then gets them with everyone.
- [ ] **Mark the couple:** in `content\guests.json` add `"role": "bride"` to one guest and `"role": "groom"` to another, restart the server. The host's guest list says "💍 bride" / "💍 groom". (Two brides → the server refuses to start and says why.)
- [ ] Questions → Main quiz (or a set) → tick **The couple plays along** (`questions.json` gets `"couple": true`). The Game panel says who plays along.
- [ ] Join on two more phones as the bride and the groom. Play the round: their phones say "You're playing for fun…" instead of a place; they're never in the Top 10, the podium or the full ranking (and not in Past games' ranking), but "X of Y answered" counts them.
- [ ] After the full ranking the big button says **The couple's answers**: each tap shows one question with the right answer (gold frame), ♥ bride and ★ groom on their answers, "Same answer!" when alike; phones show the same, smaller. The last tap shows the summary (right answers, the place each would have had, answers alike). Then "Quiz finished".
- [ ] Restart quiz → the review is gone; the next round (without the switch) counts the couple like everyone.

## 15. The new name and the event file

- [ ] Browser tab, login page and logos say **I Do! (know)**, with the new logo (ivory text, gold heart).
- [ ] You were logged out once (new cookie names): log in again, then a phone joins again (it asks for its language again once). After that, reloading keeps everyone logged in as before.
- [ ] The big screen's waiting room shows the real title from `content/event.json` in the screen's language; switch the screen language and check all five.
- [ ] Host panel → Guests → Add a missing guest: the side choices show the two names from `content/event.json`.
- [ ] Questions → + Add a question → Type: Bride or groom: the two answers start with the couple's names.
- [ ] Rename `content/event.json` for a moment and restart: the screen shows the example couple ("Anna & Ben") and the host's setup notes say the example couple is in use. Rename it back and restart.
- [ ] Break `content/event.json` (e.g. delete the `en` title) and start: the server refuses to start and says what is wrong. Fix it again.

## 16. Real phones (Phase 10, your part)

The automatic tests cover the logic, slow connections, dropped signals and the phone layout in Chromium. What only real devices show:

- [ ] An iPhone (Safari) and an older Android (Chrome or Samsung Internet) join by scanning the QR code from the big screen, play a round, and lock/unlock the phone mid-question: they come back with their name and points.
- [ ] Scan the QR code from the projector in a dimmed room, from the back of the room.
- [ ] Phone text size turned up (accessibility setting): a photo question with 4 answers still fits without scrolling.
- [ ] A phone on mobile data (Wi-Fi off) plays a whole round.

## 17. The public demo (DEMO_MODE)

- [ ] Start with `DEMO_MODE=true` (in `.env`): the login page shows the demo box with the password; "Open the host panel" and "Open the big screen" log in with one tap.
- [ ] Host panel → Guests → "Add 8 demo players": the big screen counts 8 more players; start the quiz, show the answers: the demo players answer within about 9 s, the answer is revealed by itself.
- [ ] Questions → a photo question: no "Choose a photo" button, the note says uploads are off.
- [ ] Restart the server: everything is back to the example content (your own `content/` files were never touched).

## 18. Switching the demo to the event and back

- [ ] Put test content into `event/content` (questions, guests, event) and set `EVENT_PASSWORD` (and `DEMO_MODE=true`) in `.env`. Logging in with the event password shows "Starting the event…"; after the restart the host panel opens by itself, the big screen shows the event's title, there are no demo players and no demo box, and the demo password is refused.
- [ ] With `event/content` empty or broken, the event password shows what's wrong and the demo keeps running.
- [ ] Joining → "End the event (back to the demo)…": after the restart the demo is back; the event's `data` folder is still there.

## After testing

If everything works, deploy (PowerShell, local, the same command as the other projects):

```powershell
git push deploy main
```
