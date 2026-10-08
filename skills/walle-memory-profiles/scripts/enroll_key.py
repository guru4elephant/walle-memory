#!/usr/bin/env python3
"""User-run, interactive-only Keychain enrollment. Never run this in an agent tool."""
import getpass
import json
import sys
import warnings
from pathlib import Path

from memory import DEFAULT_CONFIG, SafeError, SafeParser, load_profiles, select_profile, valid_space_key


def enroll(profile, store):
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise SafeError("Enrollment requires the user's own interactive terminal.")
    # getpass must fail rather than fall back to echoed stdin.
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        with open("/dev/tty", "r+") as tty:
            tty.write("This binds a space key to the selected alias for future local client use.\n")
            tty.write("Confirm alias by typing it: ")
            tty.flush()
            if tty.readline().rstrip("\n") != profile.alias:
                raise SafeError("Alias confirmation did not match; nothing saved.")
            secret = getpass.getpass("Space API key (hidden): ", stream=tty)
            repeated = getpass.getpass("Repeat key (hidden): ", stream=tty)
    if secret != repeated or not valid_space_key(secret):
        raise SafeError("Keys did not match or were not current scoped space keys; nothing saved.")
    try:
        store.add(profile.service, profile.account, secret)
    except Exception:
        raise SafeError("Keychain save failed or the binding already exists; nothing overwritten.") from None
    return {"saved": True, "profile": profile.alias}


def main(argv=None):
    root = SafeParser(description="User-only hidden-input enrollment; no key argument or stdin mode.")
    root.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    root.add_argument("--user", required=True)
    try:
        args = root.parse_args(argv)
        profile = select_profile(load_profiles(args.config), args.user)
        from keychain_store import MacOSKeychain
        result = enroll(profile, MacOSKeychain())
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except SafeError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2
    except (KeyboardInterrupt, EOFError):
        print('{"error":"Enrollment cancelled; no key was submitted."}', file=sys.stderr)
        return 2
    except Exception:
        print('{"error":"Enrollment failed; details suppressed."}', file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
