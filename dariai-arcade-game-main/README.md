# Prompt Mirror — AI Game Arcade

A small local game arcade. The first game, **Prompt Mirror**, works like this:

1. The app generates a hidden picture with OpenAI's image model — you don't see the prompt.
2. You study the picture and write your own prompt describing it.
3. The app generates a new picture from *your* prompt.
4. An AI judge compares the two images and scores how close you got, 0–100, with feedback.

## Running it

**Windows:** double-click `start.bat`. It opens a console window running the server and
then opens your browser to `http://127.0.0.1:8765/`.

**Mac/Linux:** run `./start.sh`, or `python3 app.py` and open `http://127.0.0.1:8765/` yourself.

The first time it opens, it will ask you to paste your OpenAI API key
(from https://platform.openai.com/api-keys). It's saved to a file on this
computer at `~/.pixel_mirror/config.json` so you're only asked once — use the
"Change API key" link at the top any time to update it.

## How it works technically

`app.py` is a small dependency-free Python server. It only serves the local
web page and stores your API key on disk — **all calls to OpenAI happen
directly from your browser tab** (see `static/app.js`), not from this script.
That means your key never leaves this computer except when talking to
OpenAI itself, and it also means the server has no external dependencies to
install.

- Image generation: `gpt-image-1` via `POST /v1/images/generations`
- Scoring/feedback: `gpt-4o-mini` via `POST /v1/chat/completions`, streamed
  live into the results screen as it's generated (the score line arrives
  first, then the feedback sentences stream in).

Each round costs a small amount of OpenAI API credit (two image generations
+ one short vision/chat call).

## Adding more games later

The arcade home screen (`screen-hub` in `static/index.html`) is already a
grid of game cards, with two "coming soon" placeholders. To add a new game,
add a new card, a new `<section class="screen">` for it, and its logic in
`static/app.js`.

## Stopping the server

Close the console window that `start.bat` opened, or press Ctrl+C in it.
