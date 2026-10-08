import contextlib
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

SCRIPTS = Path(__file__).resolve().parents[1] / "skills/walle-memory-profiles/scripts"
sys.path.insert(0, str(SCRIPTS))
import enroll_key
from memory import KEYCHAIN_SERVICE, PRODUCTION_ORIGIN, Profile, SafeError

FAKE_SECRET = "wmk_" + "c" * 64
PROFILE = Profile("alice", PRODUCTION_ORIGIN, KEYCHAIN_SERVICE, PRODUCTION_ORIGIN + "|alice")


class EnrollmentTests(unittest.TestCase):
    def test_noninteractive_fails_without_input_or_storage(self):
        store = Mock()
        with patch.object(sys.stdin, "isatty", return_value=False), \
                patch("enroll_key.getpass.getpass") as reader:
            with self.assertRaises(SafeError):
                enroll_key.enroll(PROFILE, store)
        reader.assert_not_called()
        store.add.assert_not_called()

    def simulate_terminal(self, alias, passwords, store):
        terminal = io.StringIO(alias + "\n")
        # StringIO cursor models tty input; writing prompts must not move it.
        terminal.write = Mock()
        with patch.object(sys.stdin, "isatty", return_value=True), \
                patch.object(sys.stdout, "isatty", return_value=True), \
                patch("builtins.open", return_value=terminal), \
                patch("enroll_key.getpass.getpass", side_effect=passwords):
            return enroll_key.enroll(PROFILE, store)

    def test_user_confirmed_hidden_input_only_saves_exact_binding(self):
        store = Mock()
        result = self.simulate_terminal("alice", [FAKE_SECRET, FAKE_SECRET], store)
        store.add.assert_called_once_with(PROFILE.service, PROFILE.account, FAKE_SECRET)
        self.assertNotIn(FAKE_SECRET, repr(result))
        self.assertEqual(result, {"saved": True, "profile": "alice"})

    def test_wrong_alias_does_not_read_or_save_key(self):
        store = Mock()
        with self.assertRaises(SafeError):
            self.simulate_terminal("bob", [], store)
        store.add.assert_not_called()

    def test_mismatched_or_admin_key_not_saved(self):
        for passwords in ([FAKE_SECRET, "wmk_" + "d" * 64], ["fake-admin", "fake-admin"]):
            store = Mock()
            with self.assertRaises(SafeError):
                self.simulate_terminal("alice", passwords, store)
            store.add.assert_not_called()

    def test_native_exception_text_is_suppressed(self):
        store = Mock()
        store.add.side_effect = RuntimeError(FAKE_SECRET)
        with self.assertRaises(SafeError) as caught:
            self.simulate_terminal("alice", [FAKE_SECRET, FAKE_SECRET], store)
        self.assertNotIn(FAKE_SECRET, str(caught.exception))
        self.assertIsNone(caught.exception.__cause__)

    def test_cli_does_not_echo_secret_argument(self):
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            status = enroll_key.main(["--api-key", FAKE_SECRET])
        self.assertEqual(status, 2)
        self.assertNotIn(FAKE_SECRET, output.getvalue())


if __name__ == "__main__":
    unittest.main()
