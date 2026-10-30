"""
Prompt Mirror - local game server.

This is a tiny, dependency-free local web server. It only does two things:
  1. Serves the game's static files (HTML/CSS/JS) on http://127.0.0.1:PORT
  2. Stores your OpenAI API key locally so you only have to enter it once.

All calls to OpenAI (image generation + scoring) happen directly from your
browser, not from this script - so your API key never passes through
anything except your own machine and OpenAI's servers.
"""
import http.server
import re
import socket
import socketserver
import json
import os
import random
import sys
import threading
import time
import webbrowser
from urllib.parse import urlsplit, parse_qs

PORT = 8765
# Bind to every network interface (not just 127.0.0.1) so other devices on
# the same WiFi/LAN can reach this server too, for in-person tournaments.
# This does NOT expose the game to the wider internet - your router only
# routes a private address like 192.168.x.x/10.x.x.x to devices on your own
# local network, unless you've separately set up port forwarding (which
# this app never does).
HOST = "0.0.0.0"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
CONFIG_DIR = os.path.join(os.path.expanduser("~"), ".pixel_mirror")
CONFIG_PATH = os.path.join(CONFIG_DIR, "config.json")
PLAYERS_PATH = os.path.join(CONFIG_DIR, "players.json")
TOURNAMENTS_PATH = os.path.join(CONFIG_DIR, "tournaments.json")

# Games that carry a persistent player profile. Kept as plain string keys
# (rather than importing anything from the frontend) since the two sides
# only need to agree on the same literal strings.
GAME_KEYS = ("prompt-mirror", "emoji-charades", "code-mirror", "prompt-repair")

# Guards every read-modify-write of players.json / tournaments.json /
# config.json. The server is now threaded (see ThreadedTCPServer below) so
# multiple players' devices can hit these endpoints at the same moment -
# without a lock, two near-simultaneous writes could clobber each other
# (a classic lost-update race). The lock is cheap (these are small local
# JSON files) so one global lock for all of them is simplest and safe.
STATE_LOCK = threading.Lock()


def load_config():
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_config(cfg):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f)
    try:
        os.chmod(CONFIG_PATH, 0o600)
    except Exception:
        pass


# ---------------------------------------------------------------------
# Player profiles - a small local "database" (just a JSON file) tracking
# every player who has ever typed their name into a solo round or a
# tournament roster on this computer. A player is identified purely by
# name (case-insensitive, whitespace-trimmed) - the first time a name is
# seen it gets a permanent unique id; every later round/match/tournament
# played under that same name updates the same profile. Solo stats and
# tournament stats are tracked in separate blocks per game, as requested,
# so "games played solo" never mixes with "matches played in a bracket".
# ---------------------------------------------------------------------

# Bump this whenever the SHAPE of a player's game stats changes (a new
# stat, a restructured breakdown, etc.) in a way that old saved data can't
# just be backfilled into cleanly. On the next load, every player with an
# older (or missing) statsSchemaVersion has their game history flushed -
# their identity (id, name, createdAt) is always kept - and the file is
# stamped with the new version so this only happens once per bump, not on
# every request.
CURRENT_STATS_SCHEMA_VERSION = 2


def load_players():
    if os.path.exists(PLAYERS_PATH):
        try:
            with open(PLAYERS_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict) and isinstance(data.get("players"), dict):
                    return migrate_players_if_needed(data)
        except Exception:
            pass
    return {"players": {}, "statsSchemaVersion": CURRENT_STATS_SCHEMA_VERSION}


def save_players(data):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with open(PLAYERS_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


# ---------------------------------------------------------------------
# Tournaments - server-hosted so several players on different devices can
# all see and play the same tournament. A tournament's bracket structure
# (rounds/matches/byes/seeding) is generated CLIENT-SIDE, exactly like it
# always has been (see generateBracket() in app.js) - this server never
# invents pairings, it only stores what the creating browser computed and
# then referees actual match play as it happens (prompts, scores, sub-round
# and match completion, advancing winners into the next round).
# ---------------------------------------------------------------------

def load_tournaments():
    if os.path.exists(TOURNAMENTS_PATH):
        try:
            with open(TOURNAMENTS_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict) and isinstance(data.get("tournaments"), dict):
                    return data
        except Exception:
            pass
    return {"tournaments": {}}


def save_tournaments(data):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with open(TOURNAMENTS_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def migrate_players_if_needed(data):
    stored_version = data.get("statsSchemaVersion", 1)
    if stored_version >= CURRENT_STATS_SCHEMA_VERSION:
        return data
    for player in data["players"].values():
        # Wipe accumulated game history so it gets rebuilt fresh in the
        # current shape (ensure_player_games backfills empty defaults for
        # every game/section/level on the next read) - keep everything
        # that identifies the player.
        player["games"] = {}
    data["statsSchemaVersion"] = CURRENT_STATS_SCHEMA_VERSION
    save_players(data)
    return data


# The three difficulty levels every game shares, as JSON-object-key
# strings (JSON object keys are always strings, and the level number
# arrives from the client as an int, so every read/write of a byLevel dict
# goes through str(level)).
LEVEL_KEYS = ("1", "2", "3")


def empty_level_stats():
    return {"played": 0, "totalScore": 0, "bestScore": 0}


def empty_game_stats():
    return {
        "solo": {
            "played": 0, "totalScore": 0, "bestScore": 0,
            # Same played/totalScore/bestScore shape, broken out per
            # difficulty level, so a player can be ranked "Level 2 solo"
            # separately from their overall solo average.
            "byLevel": {lvl: empty_level_stats() for lvl in LEVEL_KEYS},
        },
        "tournament": {
            "tournamentsPlayed": 0,
            "tournamentsWon": 0,
            "matchesPlayed": 0,
            "matchesWon": 0,
            "bestRoundLabel": "",
            "bestRoundRank": 0,
            # Sum of each match's cumulative total score (across that
            # match's sub-rounds) - divided by matchesPlayed client-side to
            # rank players by average tournament performance, same idea as
            # solo's totalScore/played average.
            "totalMatchScore": 0,
            # Per-level breakdown of individual tournament SUB-ROUNDS (one
            # sub-round = one level), as opposed to totalMatchScore above
            # which is a whole match's summed total across possibly several
            # levels. "played" here means sub-rounds played at that level.
            "byLevel": {lvl: empty_level_stats() for lvl in LEVEL_KEYS},
        },
    }


def ensure_player_games(player):
    """Make sure `player["games"][g]` exists (with every sub-key, including
    every level bucket) for every known game, backfilling anything missing
    so old profiles created before a stat was added still work. Also
    backfills the "role" (Dari Participant/Admin, added when per-device
    login was introduced - older profiles default to participant) and the
    "session" block used to track which device is currently signed in as
    this player (see /api/players/login below)."""
    games = player.setdefault("games", {})
    for gk in GAME_KEYS:
        g = games.setdefault(gk, {})
        defaults = empty_game_stats()
        for section in ("solo", "tournament"):
            s = g.setdefault(section, {})
            for k, v in defaults[section].items():
                if k == "byLevel":
                    by_level = s.setdefault("byLevel", {})
                    for lvl in LEVEL_KEYS:
                        by_level.setdefault(lvl, empty_level_stats())
                else:
                    s.setdefault(k, v)
    player.setdefault("role", "participant")
    session = player.setdefault("session", {})
    session.setdefault("deviceToken", None)
    session.setdefault("lastSeenAt", None)
    return player


def public_player(player):
    """A player record, minus the "session" block - that holds the
    deviceToken currently "logged in" as this player, which is effectively
    a bearer credential for /api/players/login. It must never be sent back
    to ANY client (including the rightful owner, who already has their own
    copy client-side) - otherwise any other device could read it off a
    plain player lookup and silently take over that player's session
    without ever triggering the "already active elsewhere" warning."""
    p = dict(player)
    p.pop("session", None)
    return p


# How long a device's login on a player profile is honored before it's
# considered stale and up for grabs again - covers a dropped WiFi
# connection, a closed laptop, or a crashed tab, without permanently
# stranding that person out of their own profile. The client sends a
# heartbeat (another /api/players/login call) well inside this window
# whenever that player is the one signed in on this device.
SESSION_TIMEOUT_SECONDS = 150


def find_player_by_name(players, name):
    key = name.strip().lower()
    for pid, p in players.items():
        if (p.get("name") or "").strip().lower() == key:
            return pid, p
    return None, None


# Short, typeable player IDs - deliberately not a UUID. Players read these
# off a screen and type them back in during a live tournament, so they
# need to be short and unambiguous: no 0/O, 1/I/L, which look alike in
# most fonts.
PLAYER_ID_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
PLAYER_ID_LENGTH = 5


def new_player_id(existing_ids):
    while True:
        candidate = "".join(random.choice(PLAYER_ID_ALPHABET) for _ in range(PLAYER_ID_LENGTH))
        if candidate not in existing_ids:
            return candidate


# Tournament IDs use the same short, typeable alphabet as player IDs, since
# players read/type both when joining a match from their own device.
TOURNAMENT_ID_LENGTH = 5


def new_tournament_id(existing_ids):
    while True:
        candidate = "".join(random.choice(PLAYER_ID_ALPHABET) for _ in range(TOURNAMENT_ID_LENGTH))
        if candidate not in existing_ids:
            return candidate


def apply_player_event(players_data, pid, game, etype, body):
    """Shared by POST /api/players/event AND by server-side tournament
    match play (a sub-round/match finishing on its own, without either
    player's browser needing to make a separate stats-recording call).
    Mutates players_data in place. Returns (ok, error_message_or_None)."""
    if game not in GAME_KEYS:
        return False, "Unknown game."
    player = players_data["players"].get(pid)
    if not player:
        return False, "Unknown player."
    ensure_player_games(player)
    g = player["games"][game]

    if etype == "solo":
        try:
            score = max(0, min(100, int(round(float(body.get("score", 0))))))
        except Exception:
            score = 0
        s = g["solo"]
        s["played"] += 1
        s["totalScore"] += score
        s["bestScore"] = max(s["bestScore"], score)
        level_key = str(body.get("level") or "")
        if level_key in LEVEL_KEYS:
            ls = s["byLevel"][level_key]
            ls["played"] += 1
            ls["totalScore"] += score
            ls["bestScore"] = max(ls["bestScore"], score)
    elif etype == "tournament-level":
        level_key = str(body.get("level") or "")
        if level_key not in LEVEL_KEYS:
            return False, "Unknown level."
        try:
            score = max(0, min(100, int(round(float(body.get("score", 0))))))
        except Exception:
            score = 0
        ls = g["tournament"]["byLevel"][level_key]
        ls["played"] += 1
        ls["totalScore"] += score
        ls["bestScore"] = max(ls["bestScore"], score)
    elif etype == "tournament-start":
        g["tournament"]["tournamentsPlayed"] += 1
    elif etype == "match":
        t = g["tournament"]
        t["matchesPlayed"] += 1
        if body.get("won"):
            t["matchesWon"] += 1
        try:
            rank = int(body.get("stageRank") or 0)
        except Exception:
            rank = 0
        label = body.get("stageLabel") or ""
        if rank > t.get("bestRoundRank", 0):
            t["bestRoundRank"] = rank
            t["bestRoundLabel"] = label
        try:
            match_score = max(0, int(round(float(body.get("score", 0)))))
            t["totalMatchScore"] = t.get("totalMatchScore", 0) + match_score
        except Exception:
            pass
    elif etype == "tournament-won":
        g["tournament"]["tournamentsWon"] += 1
    else:
        return False, "Unknown event type."

    player["updatedAt"] = time.time()
    return True, None


# --- Tournament bracket helpers - Python ports of the matching app.js
# functions (roundName, stageRankForRoundName, advanceWinner), used once a
# tournament is being played for real (as opposed to bracket *generation*,
# which always happens client-side and is just stored as-is on creation).

def round_name(bracket, round_index):
    matches_in_round = len(bracket[round_index])
    if matches_in_round == 1:
        return "Final"
    if matches_in_round == 2:
        return "Semifinal"
    if matches_in_round == 4:
        return "Quarterfinal"
    return f"Round of {matches_in_round * 2}"


def stage_rank_for_round_name(label):
    if label == "Final":
        return 4
    if label == "Semifinal":
        return 3
    if label == "Quarterfinal":
        return 2
    return 1


def get_match(tournament, match_id):
    try:
        ri_str, mi_str = match_id.split(":")
        ri, mi = int(ri_str), int(mi_str)
        return tournament["bracket"][ri][mi]
    except Exception:
        return None


def role_for_player(m, player_id):
    if m.get("playerA") and m["playerA"]["id"] == player_id:
        return "a"
    if m.get("playerB") and m["playerB"]["id"] == player_id:
        return "b"
    return None


def find_current_match(tournament, player_id):
    """The player's current not-yet-decided match, as (matchId, match, role),
    or (None, None, None) if they have none right now (unknown player,
    already eliminated, or they're the champion)."""
    for ri, round_ in enumerate(tournament["bracket"]):
        for mi, m in enumerate(round_):
            role = role_for_player(m, player_id)
            if role and m["status"] not in ("done", "bye"):
                return f"{ri}:{mi}", m, role
    return None, None, None


def advance_winner(t, m):
    ri = m["roundIndex"]
    next_ri = ri + 1
    if next_ri >= len(t["bracket"]):
        return
    next_match = t["bracket"][next_ri][m["matchIndex"] // 2]
    winner_ref = m["playerA"] if m["winnerId"] == m["playerA"]["id"] else m["playerB"]
    if m["matchIndex"] % 2 == 0:
        next_match["playerA"] = winner_ref
    else:
        next_match["playerB"] = winner_ref
    if next_match["playerA"] and next_match["playerB"]:
        next_match["status"] = "ready"


def clean_player_ref(p):
    if not p:
        return None
    pid = (p.get("id") or "").strip().upper()
    if not pid:
        return None
    return {"id": pid, "name": p.get("name") or pid}


def tournament_dashboard_view(t):
    """Bracket view for the list/detail endpoints - full match info
    EXCEPT the actual sub-round contents (prompts/images), which are only
    needed by the two players actively in that match (fetched separately,
    more frequently, via the per-match endpoint) and would otherwise make
    every dashboard poll ship every image generated so far."""
    bracket = []
    for round_ in t["bracket"]:
        out_round = []
        for m in round_:
            m2 = {k: v for k, v in m.items() if k != "subRounds"}
            m2["subroundCount"] = len(m.get("subRounds", []))
            out_round.append(m2)
        bracket.append(out_round)
    return {**t, "bracket": bracket}


def summarize_tournament(t):
    current_round_label = None
    ready_count = 0
    for ri, round_ in enumerate(t["bracket"]):
        unresolved = [m for m in round_ if m["status"] not in ("done", "bye")]
        if unresolved and current_round_label is None:
            current_round_label = round_name(t["bracket"], ri)
        ready_count += sum(1 for m in round_ if m["status"] in ("ready", "active"))
    champion_name = None
    if t.get("championId"):
        champion_name = (t["players"].get(t["championId"]) or {}).get("name")
    return {
        "id": t["id"],
        "name": t["name"],
        "game": t["game"],
        "createdAt": t["createdAt"],
        "status": t["status"],
        "playerCount": len(t["players"]),
        "roundLabel": current_round_label or "Finished",
        "readyCount": ready_count,
        "championName": champion_name,
    }


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/key":
            cfg = load_config()
            key = cfg.get("openai_api_key", "")
            self._send_json({"has_key": bool(key), "api_key": key})
            return
        if self.path == "/api/players":
            data = load_players()
            players = [public_player(ensure_player_games(p)) for p in data["players"].values()]
            players.sort(key=lambda p: (p.get("name") or "").lower())
            self._send_json({"players": players})
            return
        if self.path.startswith("/api/players/"):
            pid = self.path[len("/api/players/"):].split("?", 1)[0].strip().upper()
            data = load_players()
            player = data["players"].get(pid)
            if not player:
                self._send_json({"ok": False, "error": "Unknown player ID."}, status=404)
                return
            ensure_player_games(player)
            self._send_json({"ok": True, "player": public_player(player)})
            return

        parts = urlsplit(self.path)
        path = parts.path
        query = parse_qs(parts.query)

        if path == "/api/tournaments":
            game = (query.get("game", [""])[0] or "").strip()
            with STATE_LOCK:
                data = load_tournaments()
                tournaments = list(data["tournaments"].values())
            if game:
                tournaments = [t for t in tournaments if t["game"] == game]
            tournaments.sort(key=lambda t: t["createdAt"], reverse=True)
            self._send_json({"tournaments": [summarize_tournament(t) for t in tournaments]})
            return

        match_detail = re.match(r"^/api/tournaments/([A-Z0-9]+)/matches/(\d+:\d+)$", path)
        if match_detail:
            tid, match_id = match_detail.group(1), match_detail.group(2)
            with STATE_LOCK:
                data = load_tournaments()
                t = data["tournaments"].get(tid)
                m = get_match(t, match_id) if t else None
            if not t or not m:
                self._send_json({"ok": False, "error": "Unknown tournament or match."}, status=404)
                return
            self._send_json({"ok": True, "match": m, "levels": t["levels"], "game": t["game"]})
            return

        tournament_detail = re.match(r"^/api/tournaments/([A-Z0-9]+)$", path)
        if tournament_detail:
            tid = tournament_detail.group(1)
            with STATE_LOCK:
                data = load_tournaments()
                t = data["tournaments"].get(tid)
            if not t:
                self._send_json({"ok": False, "error": "Unknown tournament ID."}, status=404)
                return
            self._send_json({"ok": True, "tournament": tournament_dashboard_view(t)})
            return

        super().do_GET()

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def do_POST(self):
        if self.path == "/api/key":
            data = self._read_json_body()
            key = (data.get("api_key") or "").strip()
            if not key:
                self._send_json({"ok": False, "error": "Please paste a valid API key."}, status=400)
                return
            with STATE_LOCK:
                cfg = load_config()
                cfg["openai_api_key"] = key
                save_config(cfg)
            self._send_json({"ok": True})
            return
        if self.path == "/api/key/clear":
            with STATE_LOCK:
                cfg = load_config()
                cfg.pop("openai_api_key", None)
                save_config(cfg)
            self._send_json({"ok": True})
            return
        if self.path == "/api/players/resolve":
            body = self._read_json_body()
            name = (body.get("name") or "").strip()
            if not name:
                self._send_json({"ok": False, "error": "Name is required."}, status=400)
                return
            with STATE_LOCK:
                data = load_players()
                pid, player = find_player_by_name(data["players"], name)
                if not player:
                    pid = new_player_id(data["players"].keys())
                    player = {"id": pid, "name": name, "createdAt": time.time(), "games": {}}
                    data["players"][pid] = player
                else:
                    # Keep the latest spelling/casing the player typed.
                    player["name"] = name
                ensure_player_games(player)
                save_players(data)
            self._send_json({"ok": True, "player": public_player(player)})
            return
        if self.path == "/api/players/create":
            # Explicitly creates a brand-new profile with a fresh ID, even
            # if a profile with the same name already exists - this is how
            # two players who share a name (or someone who wants a
            # guaranteed-unique identity) get told apart. The generated ID
            # is what they type back in during play instead of their name.
            #
            # Also doubles as "sign up and log in" for the per-device
            # identity screen: a role (participant/admin - self-declared,
            # there's no password gate on this app) and a deviceToken can be
            # passed so the creating device is immediately signed in as the
            # new profile, exactly like a fresh /api/players/login call.
            body = self._read_json_body()
            name = (body.get("name") or "").strip()
            role = (body.get("role") or "participant").strip().lower()
            if role not in ("participant", "admin"):
                role = "participant"
            device_token = (body.get("deviceToken") or "").strip() or None
            if not name:
                self._send_json({"ok": False, "error": "Name is required."}, status=400)
                return
            with STATE_LOCK:
                data = load_players()
                pid = new_player_id(data["players"].keys())
                player = {"id": pid, "name": name, "role": role, "createdAt": time.time(), "games": {}}
                data["players"][pid] = player
                ensure_player_games(player)
                player["role"] = role  # ensure_player_games only backfills a MISSING role
                if device_token:
                    player["session"] = {"deviceToken": device_token, "lastSeenAt": time.time()}
                save_players(data)
            self._send_json({"ok": True, "player": public_player(player)})
            return
        if self.path == "/api/players/delete":
            # Lets the player-profiles screen clean up a typo'd or
            # duplicate profile. No confirmation server-side - the
            # frontend is expected to confirm with the person first, since
            # this permanently drops that profile's whole history.
            body = self._read_json_body()
            pid = (body.get("playerId") or "").strip().upper()
            with STATE_LOCK:
                data = load_players()
                if pid not in data["players"]:
                    self._send_json({"ok": False, "error": "Unknown player."}, status=404)
                    return
                del data["players"][pid]
                save_players(data)
            self._send_json({"ok": True})
            return
        if self.path == "/api/players/event":
            body = self._read_json_body()
            pid = (body.get("playerId") or "").strip().upper()
            game = (body.get("game") or "").strip()
            etype = (body.get("type") or "").strip()
            with STATE_LOCK:
                data = load_players()
                ok, err = apply_player_event(data, pid, game, etype, body)
                if not ok:
                    status = 404 if err == "Unknown player." else 400
                    self._send_json({"ok": False, "error": err}, status=status)
                    return
                save_players(data)
                player = data["players"][pid]
            self._send_json({"ok": True, "player": public_player(player)})
            return
        if self.path == "/api/players/role":
            # Role is self-declared everywhere else in this app (there's no
            # password backing it), so this endpoint follows the same trust
            # model rather than adding a gate nothing else here has. It
            # mainly exists so a profile that got auto-created BEFORE
            # someone ever used the identity screen (e.g. an admin typed
            # their name into a tournament roster first) isn't permanently
            # stuck as a participant.
            body = self._read_json_body()
            pid = (body.get("playerId") or "").strip().upper()
            role = (body.get("role") or "").strip().lower()
            if role not in ("participant", "admin"):
                self._send_json({"ok": False, "error": "Role must be participant or admin."}, status=400)
                return
            with STATE_LOCK:
                data = load_players()
                player = data["players"].get(pid)
                if not player:
                    self._send_json({"ok": False, "error": "Unknown player."}, status=404)
                    return
                ensure_player_games(player)
                player["role"] = role
                save_players(data)
            self._send_json({"ok": True, "player": public_player(player)})
            return
        if self.path == "/api/players/login":
            self._handle_player_login()
            return
        if self.path == "/api/players/logout":
            self._handle_player_logout()
            return

        if self.path == "/api/tournaments/create":
            self._handle_create_tournament()
            return

        join_match = re.match(r"^/api/tournaments/([A-Z0-9]+)/join$", self.path)
        if join_match:
            self._handle_join_tournament(join_match.group(1))
            return

        subround_start = re.match(r"^/api/tournaments/([A-Z0-9]+)/matches/(\d+:\d+)/subround/start$", self.path)
        if subround_start:
            self._handle_subround_start(subround_start.group(1), subround_start.group(2))
            return

        subround_prompt = re.match(r"^/api/tournaments/([A-Z0-9]+)/matches/(\d+:\d+)/subround/(\d+)/prompt$", self.path)
        if subround_prompt:
            self._handle_subround_prompt(subround_prompt.group(1), subround_prompt.group(2), int(subround_prompt.group(3)))
            return

        subround_result = re.match(r"^/api/tournaments/([A-Z0-9]+)/matches/(\d+:\d+)/subround/(\d+)/result$", self.path)
        if subround_result:
            self._handle_subround_result(subround_result.group(1), subround_result.group(2), int(subround_result.group(3)))
            return

        self._send_json({"ok": False, "error": "not found"}, status=404)

    # --- Per-device player login -------------------------------------------
    # There's no password anywhere in this app - a player ID alone is all it
    # takes to "be" that profile. What these two endpoints add is a soft
    # lock: a device only gets to submit stats and set up tournaments as a
    # given player while it holds that player's session, so a second device
    # can't quietly start acting as someone who's already playing elsewhere.
    # Because there's no real credential behind it, a second device is never
    # hard-blocked forever - it's warned and can always take over (which
    # signs the first device out), and a stale, unrefreshed session frees
    # itself after SESSION_TIMEOUT_SECONDS regardless.

    def _handle_player_login(self):
        body = self._read_json_body()
        pid = (body.get("id") or "").strip().upper()
        device_token = (body.get("deviceToken") or "").strip()
        force = bool(body.get("force"))
        if not pid or not device_token:
            self._send_json({"ok": False, "error": "Player ID and device token are required."}, status=400)
            return
        with STATE_LOCK:
            data = load_players()
            player = data["players"].get(pid)
            if not player:
                self._send_json({"ok": False, "error": "Unknown player ID."}, status=404)
                return
            ensure_player_games(player)
            session = player["session"]
            now = time.time()
            held_by_other = (
                session["deviceToken"]
                and session["deviceToken"] != device_token
                and session["lastSeenAt"]
                and (now - session["lastSeenAt"]) < SESSION_TIMEOUT_SECONDS
            )
            if held_by_other and not force:
                self._send_json({"ok": True, "status": "locked", "player": public_player(player)})
                return
            session["deviceToken"] = device_token
            session["lastSeenAt"] = now
            save_players(data)
        self._send_json({"ok": True, "status": "ok", "player": public_player(player)})

    def _handle_player_logout(self):
        body = self._read_json_body()
        pid = (body.get("id") or "").strip().upper()
        device_token = (body.get("deviceToken") or "").strip()
        with STATE_LOCK:
            data = load_players()
            player = data["players"].get(pid)
            # Best-effort and idempotent - only release the lock if it's
            # genuinely still this device's, and never error out (this is
            # called on "switch player" and isn't worth blocking on).
            if player and player.get("session", {}).get("deviceToken") == device_token:
                player["session"]["deviceToken"] = None
                player["session"]["lastSeenAt"] = None
                save_players(data)
        self._send_json({"ok": True})

    # --- Tournament endpoints --------------------------------------------
    # The bracket itself (rounds/matches/byes/seeding) is always generated
    # by the creating browser and handed to /create as-is - this server
    # never invents pairings. From then on, THIS server is authoritative
    # for match play: prompts, generated pictures, scores, sub-round and
    # match completion, and advancing winners into the next round - so two
    # players on two different devices always see the same match state.

    def _handle_create_tournament(self):
        body = self._read_json_body()
        name = (body.get("name") or "").strip() or "Untitled tournament"
        game = (body.get("game") or "").strip()
        if game not in GAME_KEYS:
            self._send_json({"ok": False, "error": "Unknown game."}, status=400)
            return
        organizer_id = (body.get("organizerId") or "").strip().upper()
        with STATE_LOCK:
            players_data = load_players()
            organizer = players_data["players"].get(organizer_id)
        if not organizer or ensure_player_games(organizer).get("role") != "admin":
            self._send_json({"ok": False, "error": "Only a Dari Admin can create a tournament."}, status=403)
            return
        try:
            levels = [int(x) for x in (body.get("levels") or [1])]
        except Exception:
            levels = [1]
        players = {}
        for p in (body.get("players") or []):
            ref = clean_player_ref(p)
            if ref:
                players[ref["id"]] = ref
        bracket_in = body.get("bracket") or []
        if len(players) < 2 or not bracket_in:
            self._send_json({"ok": False, "error": "Need at least 2 players and a generated bracket."}, status=400)
            return

        bracket = []
        for ri, round_in in enumerate(bracket_in):
            round_out = []
            for mi, m in enumerate(round_in):
                round_out.append({
                    "matchIndex": m.get("matchIndex", mi),
                    "roundIndex": ri,
                    "playerA": clean_player_ref(m.get("playerA")),
                    "playerB": clean_player_ref(m.get("playerB")),
                    "status": m.get("status") or "pending",
                    "winnerId": (m.get("winnerId") or None),
                    "totals": {},
                    "subRounds": [],
                    "needsTiebreaker": False,
                })
            bracket.append(round_out)

        with STATE_LOCK:
            data = load_tournaments()
            tid = new_tournament_id(data["tournaments"].keys())
            tournament = {
                "id": tid,
                "name": name,
                "game": game,
                "levels": levels,
                "createdAt": time.time(),
                "status": "active",
                "players": players,
                "bracket": bracket,
                "championId": None,
            }
            data["tournaments"][tid] = tournament
            save_tournaments(data)
        self._send_json({"ok": True, "tournament": tournament_dashboard_view(tournament)})

    def _handle_join_tournament(self, tid):
        body = self._read_json_body()
        player_id = (body.get("playerId") or "").strip().upper()
        if not player_id:
            self._send_json({"ok": False, "error": "Player ID is required."}, status=400)
            return
        with STATE_LOCK:
            data = load_tournaments()
            t = data["tournaments"].get(tid)
            if not t:
                self._send_json({"ok": False, "error": "Unknown tournament ID."}, status=404)
                return
            if player_id not in t["players"]:
                self._send_json({"ok": False, "error": "That player ID isn't in this tournament."}, status=404)
                return
            if t.get("championId") == player_id:
                self._send_json({"ok": True, "state": "champion", "tournament": tournament_dashboard_view(t)})
                return
            match_id, m, role = find_current_match(t, player_id)
            if not m:
                self._send_json({"ok": True, "state": "eliminated", "tournament": tournament_dashboard_view(t)})
                return
            if m["status"] == "pending":
                self._send_json({"ok": True, "state": "waiting", "tournament": tournament_dashboard_view(t)})
                return
            if m["status"] == "ready":
                m["status"] = "active"
                save_tournaments(data)
            self._send_json({
                "ok": True, "state": "playing", "matchId": match_id, "role": role,
                "match": m, "tournamentName": t["name"], "levels": t["levels"],
            })

    def _handle_subround_start(self, tid, match_id):
        body = self._read_json_body()
        player_id = (body.get("playerId") or "").strip().upper()
        try:
            index = int(body.get("index"))
            level = int(body.get("level"))
        except Exception:
            self._send_json({"ok": False, "error": "Invalid sub-round request."}, status=400)
            return
        is_tiebreaker = bool(body.get("isTiebreaker"))
        hidden_prompt = body.get("hiddenPrompt") or ""
        original_image = body.get("originalImage")
        if not hidden_prompt or not original_image:
            self._send_json({"ok": False, "error": "Missing hidden prompt/image."}, status=400)
            return

        with STATE_LOCK:
            data = load_tournaments()
            t = data["tournaments"].get(tid)
            if not t:
                self._send_json({"ok": False, "error": "Unknown tournament."}, status=404)
                return
            m = get_match(t, match_id)
            if not m or not m.get("playerA") or not m.get("playerB"):
                self._send_json({"ok": False, "error": "This match isn't ready yet."}, status=400)
                return
            if role_for_player(m, player_id) is None:
                self._send_json({"ok": False, "error": "You're not a player in this match."}, status=403)
                return
            if index != len(m["subRounds"]):
                # Someone else's device already created this (or a later)
                # sub-round - idempotent no-op, just hand back what's there
                # instead of erroring, so a race between both players'
                # devices never surfaces as a visible failure.
                self._send_json({"ok": True, "match": m, "created": False})
                return
            m["subRounds"].append({
                "index": index, "level": level, "isTiebreaker": is_tiebreaker,
                "hiddenPrompt": hidden_prompt, "originalImage": original_image,
                "a": {"prompt": "", "image": None, "score": None, "feedback": ""},
                "b": {"prompt": "", "image": None, "score": None, "feedback": ""},
                "status": "active",
            })
            if m["status"] == "ready":
                m["status"] = "active"
            save_tournaments(data)
        self._send_json({"ok": True, "match": m, "created": True})

    def _handle_subround_prompt(self, tid, match_id, sub_index):
        body = self._read_json_body()
        player_id = (body.get("playerId") or "").strip().upper()
        prompt = (body.get("prompt") or "").strip()
        if not prompt:
            self._send_json({"ok": False, "error": "Prompt is required."}, status=400)
            return
        with STATE_LOCK:
            data = load_tournaments()
            t = data["tournaments"].get(tid)
            m = get_match(t, match_id) if t else None
            if not m or sub_index >= len(m["subRounds"]):
                self._send_json({"ok": False, "error": "Unknown sub-round."}, status=404)
                return
            role = role_for_player(m, player_id)
            if role is None:
                self._send_json({"ok": False, "error": "You're not a player in this match."}, status=403)
                return
            sub = m["subRounds"][sub_index]
            if not sub[role]["prompt"]:
                sub[role]["prompt"] = prompt
                save_tournaments(data)
        self._send_json({"ok": True, "match": m})

    def _handle_subround_result(self, tid, match_id, sub_index):
        body = self._read_json_body()
        player_id = (body.get("playerId") or "").strip().upper()
        image = body.get("image")
        try:
            score = max(0, min(100, int(round(float(body.get("score", 0))))))
        except Exception:
            score = 0
        feedback = body.get("feedback") or ""
        if not image:
            self._send_json({"ok": False, "error": "Missing image."}, status=400)
            return

        with STATE_LOCK:
            data = load_tournaments()
            t = data["tournaments"].get(tid)
            m = get_match(t, match_id) if t else None
            if not m or sub_index >= len(m["subRounds"]):
                self._send_json({"ok": False, "error": "Unknown sub-round."}, status=404)
                return
            role = role_for_player(m, player_id)
            if role is None:
                self._send_json({"ok": False, "error": "You're not a player in this match."}, status=403)
                return
            sub = m["subRounds"][sub_index]
            if sub[role]["score"] is None:
                sub[role]["image"] = image
                sub[role]["score"] = score
                sub[role]["feedback"] = feedback

                if sub["a"]["score"] is not None and sub["b"]["score"] is not None and sub["status"] != "done":
                    self._finalize_subround(t, m, sub)

            save_tournaments(data)
        self._send_json({"ok": True, "match": m})

    def _finalize_subround(self, t, m, sub):
        """Called only once, exactly when a sub-round's second score comes
        in. Updates match totals, records both players' per-level stats,
        and - if this was the match's last planned sub-round - decides the
        match (or flags that a tiebreaker sub-round is needed) and advances
        the winner into the bracket's next round. Always called from inside
        the caller's STATE_LOCK, with tournaments.json already loaded."""
        sub["status"] = "done"
        a_id = m["playerA"]["id"]
        b_id = m["playerB"]["id"]
        m["totals"][a_id] = m["totals"].get(a_id, 0) + sub["a"]["score"]
        m["totals"][b_id] = m["totals"].get(b_id, 0) + sub["b"]["score"]

        players_data = load_players()
        apply_player_event(players_data, a_id, t["game"], "tournament-level",
                            {"level": sub["level"], "score": sub["a"]["score"]})
        apply_player_event(players_data, b_id, t["game"], "tournament-level",
                            {"level": sub["level"], "score": sub["b"]["score"]})

        done_count = sum(1 for s in m["subRounds"] if s["status"] == "done")
        planned = len(t["levels"])
        if done_count >= planned:
            if m["totals"][a_id] == m["totals"][b_id]:
                m["needsTiebreaker"] = True
            else:
                m["needsTiebreaker"] = False
                m["status"] = "done"
                winner_id = a_id if m["totals"][a_id] > m["totals"][b_id] else b_id
                m["winnerId"] = winner_id
                ri = m["roundIndex"]
                is_final = ri == len(t["bracket"]) - 1
                stage_label = round_name(t["bracket"], ri)
                stage_rank = stage_rank_for_round_name(stage_label)
                apply_player_event(players_data, a_id, t["game"], "match", {
                    "won": winner_id == a_id, "stageLabel": stage_label,
                    "stageRank": stage_rank, "score": m["totals"][a_id],
                })
                apply_player_event(players_data, b_id, t["game"], "match", {
                    "won": winner_id == b_id, "stageLabel": stage_label,
                    "stageRank": stage_rank, "score": m["totals"][b_id],
                })
                advance_winner(t, m)
                if is_final:
                    apply_player_event(players_data, winner_id, t["game"], "tournament-won", {})
                    t["championId"] = winner_id
                    t["status"] = "done"
        else:
            m["needsTiebreaker"] = False
        save_players(players_data)

    def log_message(self, format, *args):
        # Keep the console quiet; comment this out if you want request logs.
        pass


def get_lan_ip():
    """Best-effort guess at this machine's LAN IP address (the one other
    devices on the same WiFi would use to reach it). Doesn't actually send
    any traffic - just asks the OS which local interface it would route
    through to reach an outside address."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return None
    finally:
        s.close()


class ThreadedTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    # Multiple players on the LAN can hit the server (loading the page,
    # fetching/saving player profiles, etc.) at the same moment - handle
    # each request on its own thread instead of making everyone queue
    # behind a single in-progress request.
    daemon_threads = True
    allow_reuse_address = True


def main():
    with ThreadedTCPServer((HOST, PORT), Handler) as httpd:
        local_url = f"http://127.0.0.1:{PORT}/"
        lan_ip = get_lan_ip()
        print("=" * 50)
        print(" Prompt Mirror is running")
        print(f" On this computer:      {local_url}")
        if lan_ip:
            print(f" For other players on your WiFi: http://{lan_ip}:{PORT}/")
        else:
            print(" Couldn't detect a LAN IP - find this computer's WiFi IP")
            print(f" address yourself and share http://<that address>:{PORT}/")
        print(" (They must be on the same WiFi/network as this computer.)")
        print(" Press Ctrl+C here to stop the server.")
        print("=" * 50)
        try:
            threading.Timer(1.0, lambda: webbrowser.open(local_url)).start()
        except Exception:
            pass
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopping server...")
            sys.exit(0)


if __name__ == "__main__":
    main()
