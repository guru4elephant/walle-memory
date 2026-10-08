#!/usr/bin/env python3
"""Walle Workers client. Credentials never enter CLI arguments or files."""
import argparse
import json
import math
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

PRODUCTION_ORIGIN = "https://walle-memory.dongdaxiang.xyz"
KEYCHAIN_SERVICE = "xyz.dongdaxiang.walle-memory.space-key.v1"
DEFAULT_CONFIG = Path.home() / ".config/walle-memory/profiles.json"
MAX_RESPONSE_BYTES = 4 * 1024 * 1024


class SafeError(Exception):
    """Only fixed, credential-free messages may be passed here."""


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise SafeError("Invalid command arguments; run --help.")


def valid_alias(alias):
    return isinstance(alias, str) and bool(re.fullmatch(r"[\w][\w.-]{0,63}", alias))


def valid_space_key(secret):
    # The current account API issues wmk_ + randomHex(32). Reject admin/legacy keys.
    return isinstance(secret, str) and bool(re.fullmatch(r"wmk_[0-9a-f]{64}", secret))


@dataclass(frozen=True)
class Profile:
    alias: str
    origin: str
    service: str
    account: str


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise SafeError("Duplicate JSON fields are not supported.")
        result[key] = value
    return result


def read_json(path, limit):
    try:
        with Path(path).open("rb") as stream:
            raw = stream.read(limit + 1)
        if len(raw) > limit:
            raise SafeError("Input file exceeds the size limit.")
        return json.loads(raw, object_pairs_hook=unique_object)
    except SafeError:
        raise
    except Exception:
        raise SafeError("Cannot read a valid JSON input file.") from None


def load_profiles(path, *, allowed_origins=(PRODUCTION_ORIGIN,)):
    """The CLI uses the fixed production allowlist; tests inject loopback origins."""
    raw = read_json(path, 128 * 1024)
    if (not isinstance(raw, dict) or set(raw) != {"version", "profiles"}
            or type(raw["version"]) is not int or raw["version"] != 1
            or not isinstance(raw["profiles"], dict) or not raw["profiles"]):
        raise SafeError("Invalid profile configuration; use the reference schema.")
    profiles = {}
    accounts = set()
    for alias, item in raw["profiles"].items():
        if (not valid_alias(alias) or not isinstance(item, dict)
                or set(item) != {"origin", "credential"}):
            raise SafeError("Invalid profile configuration; inline secrets are forbidden.")
        origin = item["origin"]
        ref = item["credential"]
        if (not isinstance(origin, str) or origin not in allowed_origins
                or not isinstance(ref, dict)
                or set(ref) != {"provider", "service", "account"}
                or ref["provider"] != "macos-keychain"
                or ref["service"] != KEYCHAIN_SERVICE
                or ref["account"] != origin + "|" + alias):
            raise SafeError("Invalid origin or credential reference in profile configuration.")
        account = ref["account"]
        if account in accounts:
            raise SafeError("Profiles must not share a credential reference.")
        accounts.add(account)
        profiles[alias] = Profile(alias, origin, KEYCHAIN_SERVICE, account)
    return profiles


def select_profile(profiles, user):
    if user is None:
        raise SafeError("Specify --user explicitly; there is no default profile.")
    if not valid_alias(user) or user not in profiles:
        raise SafeError("Unknown profile; choose an explicitly configured --user.")
    return profiles[user]


def checked_text(value, limit, *, nonempty=False):
    if (not isinstance(value, str) or "\0" in value
            or (nonempty and not value.strip())):
        raise SafeError("Invalid memory field.")
    try:
        if len(value.encode("utf-8")) > limit:
            raise SafeError("Memory field exceeds the size limit.")
    except UnicodeError:
        raise SafeError("Invalid memory field encoding.") from None
    return value


def key_path(key):
    checked_text(key, 1024, nonempty=True)
    if key in {"search", "gc", ".", ".."}:
        raise SafeError("This memory key is reserved; choose a different key.")
    return "/memory/" + urllib.parse.quote(key, safe="")


def checked_payload(payload):
    if (not isinstance(payload, dict)
            or not {"value", "description"}.issubset(payload)
            or set(payload) - {"value", "description", "ttl_seconds"}):
        raise SafeError("Put requires value and description; only ttl_seconds is optional.")
    checked_text(payload["value"], 256 * 1024)
    checked_text(payload["description"], 8 * 1024)
    if "ttl_seconds" in payload:
        ttl = payload["ttl_seconds"]
        try:
            valid = (type(ttl) in (int, float) and math.isfinite(ttl) and ttl > 0
                     and math.ceil(time.time() * 1000 + ttl * 1000) <= 2**53 - 1)
        except (OverflowError, ValueError):
            valid = False
        if not valid:
            raise SafeError("ttl_seconds must be finite and positive within the server limit.")
    raw = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
    if len(raw) > 1024 * 1024:
        raise SafeError("Request body exceeds the size limit.")
    return raw


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Refuse all redirects, including same-origin ones; never forward the header.
        return None


class Transport:
    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, profile, secret, method, path, body=None):
        if not path.startswith("/") or path.startswith("//"):
            raise SafeError("Invalid request route.")
        request = urllib.request.Request(
            profile.origin + path, data=body, method=method,
            headers={"X-Api-Key": secret, "Accept": "application/json",
                     "Content-Type": "application/json", "User-Agent": "walle-memory-profiles/1"})
        try:
            with self.opener.open(request, timeout=20) as response:
                if not 200 <= response.status < 300:
                    raise SafeError("Unexpected HTTP response.")
                raw = response.read(MAX_RESPONSE_BYTES + 1)
                if len(raw) > MAX_RESPONSE_BYTES:
                    raise SafeError("Response exceeds the size limit.")
                try:
                    result = json.loads(raw)
                except Exception:
                    raise SafeError("Server returned invalid JSON.") from None
                return redact(result, secret)
        except urllib.error.HTTPError as error:
            # Do not read/print remote error bodies, Location, URLs, or raw exceptions.
            code = error.code
            error.close()
            messages = {401: "Credential rejected, expired, revoked, or account disabled.",
                        403: "Space key lacks the required permission.",
                        404: "Memory entry or route was not found.",
                        429: "Rate limited; retry later after reviewing the operation."}
            if 300 <= code < 400:
                raise SafeError("Redirect refused; credential was not forwarded.") from None
            raise SafeError(messages.get(code, "Walle request failed; remote details suppressed.")) from None
        except SafeError:
            raise
        except Exception:
            raise SafeError("Network request failed; details suppressed.") from None


def redact(value, secret):
    if isinstance(value, str):
        # Exact current key and all complete scoped keys are suppressed in memory output.
        return re.sub(r"wmk_[0-9a-f]{64}", "[REDACTED_SPACE_KEY]",
                      value.replace(secret, "[REDACTED_SPACE_KEY]"), flags=re.IGNORECASE)
    if isinstance(value, list):
        return [redact(item, secret) for item in value]
    if isinstance(value, dict):
        return {redact(key, secret): redact(item, secret) for key, item in value.items()}
    return value


def execute(args, profiles, store, transport):
    if args.command == "profiles":
        return {"profiles": sorted(profiles)}
    profile = select_profile(profiles, args.user)
    body = None
    if args.command == "summary":
        method, path = "GET", "/summary"
    elif args.command == "list":
        method, path = "GET", "/memory"
        if args.prefix is not None:
            checked_text(args.prefix, 1024)
            path += "?" + urllib.parse.urlencode({"prefix": args.prefix})
    elif args.command == "search":
        checked_text(args.query, 2048, nonempty=True)
        method, path = "GET", "/memory/search?" + urllib.parse.urlencode({"q": args.query})
    elif args.command in {"get", "put", "delete"}:
        path = key_path(args.memory_key)
        method = {"get": "GET", "put": "PUT", "delete": "DELETE"}[args.command]
        if args.command == "put":
            body = checked_payload(read_json(args.body_file, 1024 * 1024))
        elif args.command == "delete" and args.confirm_target != profile.alias + ":" + args.memory_key:
            raise SafeError("Deletion requires --confirm-target matching user:memory-key.")
    elif args.command == "gc":
        if args.confirm_target != profile.alias + ":expired":
            raise SafeError("GC requires --confirm-target matching user:expired.")
        method, path = "POST", "/memory/gc"
    else:
        raise SafeError("Unsupported memory command.")
    try:
        secret = store.get(profile.service, profile.account)
    except Exception:
        raise SafeError("Credential unavailable; enroll the selected profile locally or unlock Keychain.") from None
    if not valid_space_key(secret):
        raise SafeError("A current scoped space key is required; admin and legacy keys are not supported.")
    try:
        result = transport.request(profile, secret, method, path, body)
    except SafeError:
        raise
    except Exception:
        raise SafeError("Request failed; details suppressed.") from None
    return {"profile": profile.alias, "result": redact(result, secret)}


def parser():
    root = SafeParser(description="Walle memory client with explicit local profiles.")
    root.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    root.add_argument("--user", help="Explicit local profile alias (never sent to the server)")
    commands = root.add_subparsers(dest="command", required=True, parser_class=SafeParser)
    commands.add_parser("profiles", help="List configured aliases without reading Keychain")
    commands.add_parser("summary")
    listing = commands.add_parser("list")
    listing.add_argument("--prefix")
    search = commands.add_parser("search")
    search.add_argument("query")
    for command in ("get", "put", "delete"):
        sub = commands.add_parser(command)
        sub.add_argument("memory_key")
        if command == "put":
            sub.add_argument("--body-file", type=Path, required=True)
        if command == "delete":
            sub.add_argument("--confirm-target", required=True)
    gc = commands.add_parser("gc")
    gc.add_argument("--confirm-target", required=True)
    return root


def main(argv=None):
    try:
        args = parser().parse_args(argv)
        if args.command != "profiles" and args.user is None:
            raise SafeError("Specify --user explicitly; there is no default profile.")
        profiles = load_profiles(args.config)
        if args.command == "profiles":
            result = {"profiles": sorted(profiles)}
        else:
            from keychain_store import MacOSKeychain
            result = execute(args, profiles, MacOSKeychain(), Transport())
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        return 0
    except SafeError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2
    except (KeyboardInterrupt, EOFError):
        print('{"error":"Operation cancelled."}', file=sys.stderr)
        return 2
    except Exception:
        print('{"error":"Operation failed; details suppressed."}', file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
