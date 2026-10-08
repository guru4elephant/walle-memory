"""Credential isolation tests for the uninstalled Walle memory skill candidate.

Every credential is a syntactically valid fake. Network requests stay on two
loopback HTTP servers; CLI tests replace the Keychain implementation entirely.
Run from this task directory: python3 -m unittest discover -s tests -v
"""
import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import threading
import traceback
import types
import unittest
import urllib.error
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock


CANDIDATE_SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "skills/walle-memory-profiles/scripts/memory.py"
)
SPEC = importlib.util.spec_from_file_location("walle_memory_candidate", CANDIDATE_SCRIPT)
memory = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = memory
SPEC.loader.exec_module(memory)

ALICE_KEY = "wmk_" + "a" * 64
BOB_KEY = "wmk_" + "b" * 64
OTHER_KEY = "wmk_" + "c" * 64
OTHER_CASE_KEY = OTHER_KEY.upper()
ALIASES = ("alice-profile", "bob-profile")


class FakeStore:
    """Only in-memory fake credentials; never instantiates MacOSKeychain."""

    def __init__(self, credentials=None, exception=None):
        self.credentials = dict(credentials or {})
        self.exception = exception
        self.get_calls = []

    def get(self, service, account):
        self.get_calls.append((service, account))
        if self.exception is not None:
            raise self.exception
        return self.credentials.get((service, account))


class FakeTransport:
    def __init__(self, result=None, exception=None):
        self.result = {} if result is None else result
        self.exception = exception
        self.requests = []

    def request(self, profile, secret, method, path, body=None):
        self.requests.append((profile, secret, method, path, body))
        if self.exception is not None:
            raise self.exception
        return self.result


class LoopbackState:
    def __init__(self):
        self.requests = []
        self.routes = {}
        self.lock = threading.Lock()

    def clear(self):
        with self.lock:
            self.requests.clear()
            self.routes.clear()


def make_handler(state):
    class Handler(BaseHTTPRequestHandler):
        def handle_request(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            record = {
                "method": self.command,
                "path": self.path,
                "headers": {name.lower(): value for name, value in self.headers.items()},
                "body": body,
            }
            with state.lock:
                state.requests.append(record)
                response = state.routes.get((self.command, self.path), {})
            status = response.get("status", 200)
            raw = response.get("body", b'{"ok":true}')
            if not isinstance(raw, bytes):
                raw = json.dumps(raw, ensure_ascii=False).encode("utf-8")
            self.send_response(status, response.get("reason"))
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            for name, value in response.get("headers", {}).items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(raw)

        do_GET = handle_request
        do_PUT = handle_request
        do_DELETE = handle_request
        do_POST = handle_request

        def log_message(self, *_args):
            # The test server must not produce HTTP request or error logs.
            pass

    return Handler


class CandidateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source_state = LoopbackState()
        cls.sink_state = LoopbackState()
        cls.source_server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(cls.source_state))
        cls.sink_server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(cls.sink_state))
        cls.source_server.daemon_threads = True
        cls.sink_server.daemon_threads = True
        cls.source_origin = "http://127.0.0.1:" + str(cls.source_server.server_port)
        cls.sink_origin = "http://127.0.0.1:" + str(cls.sink_server.server_port)
        cls.server_threads = []
        for server in (cls.source_server, cls.sink_server):
            thread = threading.Thread(
                target=lambda s=server: s.serve_forever(poll_interval=0.01), daemon=True
            )
            thread.start()
            cls.server_threads.append(thread)

    @classmethod
    def tearDownClass(cls):
        for server in (cls.source_server, cls.sink_server):
            server.shutdown()
            server.server_close()
        for thread in cls.server_threads:
            thread.join(timeout=2)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="walle-memory-fake-tests-")
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.source_state.clear()
        self.sink_state.clear()
        self.config = self.folder / "profiles.json"
        self.write_config(self.config, self.config_data(self.source_origin))
        self.profiles = memory.load_profiles(self.config, allowed_origins=(self.source_origin,))
        self.store = self.make_store(self.profiles)

    def config_data(self, origin):
        return {
            "version": 1,
            "profiles": {
                alias: {
                    "origin": origin,
                    "credential": {
                        "provider": "macos-keychain",
                        "service": memory.KEYCHAIN_SERVICE,
                        "account": origin + "|" + alias,
                    },
                }
                for alias in ALIASES
            },
        }

    def write_config(self, path, value):
        path.write_text(json.dumps(value), encoding="utf-8")

    def make_store(self, profiles):
        return FakeStore({
            (profiles[ALIASES[0]].service, profiles[ALIASES[0]].account): ALICE_KEY,
            (profiles[ALIASES[1]].service, profiles[ALIASES[1]].account): BOB_KEY,
        })

    def args(self, command, *, user=ALIASES[0], **fields):
        return types.SimpleNamespace(command=command, user=user, **fields)

    def execute(self, command, *, user=ALIASES[0], store=None, transport=None, **fields):
        return memory.execute(
            self.args(command, user=user, **fields), self.profiles,
            self.store if store is None else store,
            memory.Transport() if transport is None else transport,
        )

    def put_file(self, payload):
        path = self.folder / "body.json"
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return path

    def assert_safe(self, text):
        for secret in (ALICE_KEY, BOB_KEY, OTHER_KEY, OTHER_CASE_KEY):
            self.assertNotIn(secret, str(text))
            self.assertNotIn(secret.upper(), str(text))

    def assert_no_network(self):
        self.assertEqual(self.source_state.requests, [])
        self.assertEqual(self.sink_state.requests, [])

    def run_cli(self, argv, *, store=None, transport=None):
        fake_store = FakeStore() if store is None else store
        fake_transport = FakeTransport() if transport is None else transport
        fake_keychain = types.ModuleType("keychain_store")
        fake_keychain.MacOSKeychain = lambda: fake_store
        stdout, stderr = io.StringIO(), io.StringIO()
        with (
            mock.patch.dict(sys.modules, {"keychain_store": fake_keychain}),
            mock.patch.object(memory, "Transport", return_value=fake_transport),
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(stderr),
        ):
            status = memory.main(argv)
        return status, stdout.getvalue(), stderr.getvalue(), fake_store, fake_transport

    def test_two_aliases_use_only_their_bound_keys_and_do_not_upload_aliases(self):
        for alias, expected_key in zip(ALIASES, (ALICE_KEY, BOB_KEY)):
            result = self.execute("summary", user=alias)
            self.assertEqual(result["profile"], alias)
            request = self.source_state.requests[-1]
            self.assertEqual(request["headers"]["x-api-key"], expected_key)
            self.assertEqual((request["method"], request["path"], request["body"]),
                             ("GET", "/summary", b""))
            for other_alias in ALIASES:
                self.assertNotIn(other_alias, json.dumps(request, default=str))
        self.assertEqual(self.store.get_calls, [
            (self.profiles[alias].service, self.profiles[alias].account) for alias in ALIASES
        ])
        self.assertNotEqual(self.profiles[ALIASES[0]].account, self.profiles[ALIASES[1]].account)

    def test_missing_unknown_and_invalid_user_do_not_read_secrets(self):
        for user in (None, "unknown-profile", "bad user", ALICE_KEY):
            with self.subTest(user="missing" if user is None else "provided"):
                with self.assertRaises(memory.SafeError) as raised:
                    self.execute("summary", user=user)
                self.assert_safe(str(raised.exception))
                self.assertEqual(self.store.get_calls, [])
                self.assert_no_network()

    def test_profiles_command_never_reads_credentials_or_makes_network_request(self):
        result = self.execute("profiles", user=None)
        self.assertEqual(result, {"profiles": sorted(ALIASES)})
        self.assertEqual(self.store.get_calls, [])
        self.assert_no_network()

    def test_missing_invalid_and_admin_credentials_fail_before_network(self):
        profile = self.profiles[ALIASES[0]]
        ref = (profile.service, profile.account)
        for secret in (None, "", "admin-fake", "mk_" + "a" * 64,
                       "wmk_" + "a" * 63, "wmk_" + "a" * 65):
            with self.subTest(kind="missing" if secret is None else "invalid"):
                store = FakeStore({ref: secret})
                with self.assertRaises(memory.SafeError) as raised:
                    self.execute("summary", store=store)
                self.assert_safe(str(raised.exception))
                self.assertEqual(store.get_calls, [ref])
                self.assert_no_network()

    def test_secret_store_exception_is_suppressed_without_network(self):
        store = FakeStore(exception=RuntimeError("secret fetch failed: " + ALICE_KEY))
        with self.assertRaises(memory.SafeError) as raised:
            self.execute("summary", store=store)
        self.assert_safe("".join(traceback.format_exception(raised.exception)))
        self.assert_no_network()

    def test_inline_secret_config_fields_are_rejected(self):
        for location, field in (("root", "key"), ("profile", "api_key"),
                                ("credential", "secret"), ("credential", "password")):
            with self.subTest(location=location, field=field):
                raw = self.config_data(self.source_origin)
                target = raw
                if location != "root":
                    target = raw["profiles"][ALIASES[0]]
                if location == "credential":
                    target = target["credential"]
                target[field] = ALICE_KEY
                self.write_config(self.config, raw)
                with self.assertRaises(memory.SafeError) as raised:
                    memory.load_profiles(self.config, allowed_origins=(self.source_origin,))
                self.assert_safe(str(raised.exception))
        self.assertEqual(self.store.get_calls, [])
        self.assert_no_network()

    def test_credential_provider_service_and_account_are_fixed(self):
        replacements = {
            "provider": "environment", "service": "unrelated-service",
            "account": self.source_origin + "|" + ALIASES[1],
        }
        for field, replacement in replacements.items():
            with self.subTest(field=field):
                raw = self.config_data(self.source_origin)
                raw["profiles"][ALIASES[0]]["credential"][field] = replacement
                self.write_config(self.config, raw)
                with self.assertRaises(memory.SafeError):
                    memory.load_profiles(self.config, allowed_origins=(self.source_origin,))

    def test_two_aliases_cannot_share_a_credential_reference(self):
        raw = self.config_data(self.source_origin)
        raw["profiles"][ALIASES[1]]["credential"] = dict(
            raw["profiles"][ALIASES[0]]["credential"]
        )
        self.write_config(self.config, raw)
        with self.assertRaises(memory.SafeError):
            memory.load_profiles(self.config, allowed_origins=(self.source_origin,))
        self.assert_no_network()

    def test_config_cannot_change_production_origin(self):
        candidates = (
            self.source_origin,
            "https://walle-memory.dongdaxiang.xyz.evil.invalid",
            "https://walle-memory.dongdaxiang.xyz@evil.invalid",
            memory.PRODUCTION_ORIGIN + "/",
            memory.PRODUCTION_ORIGIN + "/path",
            memory.PRODUCTION_ORIGIN + "?api_key=" + ALICE_KEY,
            memory.PRODUCTION_ORIGIN + "#" + ALICE_KEY,
        )
        for origin in candidates:
            with self.subTest(kind="untrusted-origin"):
                self.write_config(self.config, self.config_data(origin))
                with self.assertRaises(memory.SafeError) as raised:
                    memory.load_profiles(self.config)
                self.assert_safe(str(raised.exception))
        self.assert_no_network()

    def test_production_schema_is_accepted_without_reading_any_secret(self):
        self.write_config(self.config, self.config_data(memory.PRODUCTION_ORIGIN))
        profiles = memory.load_profiles(self.config)
        self.assertEqual(set(profiles), set(ALIASES))
        self.assertTrue(all(profile.origin == memory.PRODUCTION_ORIGIN for profile in profiles.values()))
        self.assertEqual(self.store.get_calls, [])
        self.assert_no_network()

    def test_duplicate_json_fields_are_rejected_without_echoing_content(self):
        self.config.write_text('{"version":1,"version":"' + ALICE_KEY + '","profiles":{}}')
        with self.assertRaises(memory.SafeError) as raised:
            memory.load_profiles(self.config)
        self.assert_safe(str(raised.exception))
        path = self.folder / "duplicate-body.json"
        path.write_text('{"value":"x","value":"' + ALICE_KEY + '","description":"x"}')
        with self.assertRaises(memory.SafeError) as raised:
            self.execute("put", memory_key="entry", body_file=path)
        self.assert_safe(str(raised.exception))
        self.assertEqual(self.store.get_calls, [])
        self.assert_no_network()

    def test_crud_list_search_summary_routes_and_encoding(self):
        key = "folder/a b?&+#%中文"
        encoded_key = urllib.parse.quote(key, safe="")
        prefix = "folder/文 +?&"
        query = "hello 中文 +?&"
        payload = {"value": "实际值", "description": "说明", "ttl_seconds": 12.5}
        operations = (
            ("get", {"memory_key": key}, "GET", "/memory/" + encoded_key),
            ("put", {"memory_key": key, "body_file": self.put_file(payload)}, "PUT", "/memory/" + encoded_key),
            ("delete", {"memory_key": key, "confirm_target": ALIASES[0] + ":" + key}, "DELETE", "/memory/" + encoded_key),
            ("list", {"prefix": None}, "GET", "/memory"),
            ("list", {"prefix": prefix}, "GET", "/memory?" + urllib.parse.urlencode({"prefix": prefix})),
            ("search", {"query": query}, "GET", "/memory/search?" + urllib.parse.urlencode({"q": query})),
            ("summary", {}, "GET", "/summary"),
        )
        for command, fields, method, path in operations:
            with self.subTest(command=command):
                self.execute(command, **fields)
                record = self.source_state.requests[-1]
                self.assertEqual((record["method"], record["path"]), (method, path))
                self.assertEqual(record["headers"]["x-api-key"], ALICE_KEY)
                if command == "put":
                    self.assertEqual(json.loads(record["body"]), payload)
                else:
                    self.assertEqual(record["body"], b"")
                for alias in ALIASES:
                    self.assertNotIn(alias, record["path"])
                    self.assertNotIn(alias.encode(), record["body"])
        self.assertEqual(len(self.source_state.requests), len(operations))

    def test_reserved_empty_and_null_memory_keys_fail_before_secret_fetch(self):
        for key in ("search", "gc", ".", "..", "", "   ", "bad\0key"):
            with self.subTest(key=repr(key)):
                for command in ("get", "put", "delete"):
                    fields = {"memory_key": key}
                    if command == "put":
                        fields["body_file"] = self.put_file({"value": "v", "description": "d"})
                    elif command == "delete":
                        fields["confirm_target"] = ALIASES[0] + ":" + key
                    with self.assertRaises(memory.SafeError):
                        self.execute(command, **fields)
        self.assertEqual(self.store.get_calls, [])
        self.assert_no_network()

    def test_put_requires_value_and_description_and_rejects_extra_fields(self):
        invalid = (
            {}, {"value": "v"}, {"description": "d"},
            {"value": "v", "description": "d", "key": "other"},
            {"value": {}, "description": "d"},
            {"value": "v", "description": 7},
            {"value": "v\0", "description": "d"},
            {"value": "v", "description": "d", "api_key": ALICE_KEY},
        )
        for payload in invalid:
            with self.subTest(field_count=len(payload)):
                with self.assertRaises(memory.SafeError) as raised:
                    self.execute("put", memory_key="entry", body_file=self.put_file(payload))
                self.assert_safe(str(raised.exception))
        self.assertEqual(self.store.get_calls, [])
        self.assert_no_network()

    def test_put_without_ttl_sends_no_ttl_or_expiration_override(self):
        payload = {"value": "", "description": ""}
        self.execute("put", memory_key="entry", body_file=self.put_file(payload))
        body = json.loads(self.source_state.requests[-1]["body"])
        self.assertEqual(body, payload)
        self.assertNotIn("ttl_seconds", body)
        self.assertNotIn("expires_at", body)

    def test_ttl_accepts_positive_number_and_rejects_nonfinite_boolean_and_overflow(self):
        for ttl in (0.01, 1, 3600.5):
            with self.subTest(valid_ttl=ttl):
                raw = memory.checked_payload({"value": "v", "description": "d", "ttl_seconds": ttl})
                self.assertEqual(json.loads(raw)["ttl_seconds"], ttl)
        for ttl in (None, False, True, 0, -1, "60", [], {}, float("inf"),
                    float("-inf"), float("nan"), 10**1000, 2**53):
            with self.subTest(invalid_type=type(ttl).__name__):
                with self.assertRaises(memory.SafeError):
                    memory.checked_payload({"value": "v", "description": "d", "ttl_seconds": ttl})

    def test_utf8_field_size_limits_are_enforced_by_bytes(self):
        for payload in (
            {"value": "文" * (256 * 1024 // 3 + 1), "description": "d"},
            {"value": "v", "description": "文" * (8 * 1024 // 3 + 1)},
        ):
            with self.assertRaises(memory.SafeError):
                memory.checked_payload(payload)
        with self.assertRaises(memory.SafeError):
            self.execute("get", memory_key="文" * (1024 // 3 + 1))
        self.assertEqual(self.store.get_calls, [])
        self.assert_no_network()

    def test_delete_confirmation_must_bind_both_selected_user_and_exact_target(self):
        key = "folder:entry"
        for confirmation in (None, key, ALIASES[0], ALIASES[1] + ":" + key,
                             ALIASES[0] + ":other", ALIASES[0] + ":" + key + " "):
            with self.subTest(confirmation="mismatch"):
                with self.assertRaises(memory.SafeError):
                    self.execute("delete", memory_key=key, confirm_target=confirmation)
        self.assertEqual(self.store.get_calls, [])
        self.assert_no_network()
        self.execute("delete", memory_key=key, confirm_target=ALIASES[0] + ":" + key)
        self.assertEqual(self.source_state.requests[-1]["method"], "DELETE")

    def test_gc_confirmation_binds_selected_user_and_expired_target(self):
        for confirmation in (None, "expired", ALIASES[1] + ":expired",
                             ALIASES[0] + ":all", ALIASES[0] + ":expired "):
            with self.subTest(confirmation="mismatch"):
                with self.assertRaises(memory.SafeError):
                    self.execute("gc", confirm_target=confirmation)
        self.assertEqual(self.store.get_calls, [])
        self.assert_no_network()
        self.execute("gc", confirm_target=ALIASES[0] + ":expired")
        record = self.source_state.requests[-1]
        self.assertEqual((record["method"], record["path"], record["body"]),
                         ("POST", "/memory/gc", b""))

    def test_http_error_body_reason_and_redirect_location_are_never_output(self):
        for status in (400, 401, 403, 404, 429, 500):
            with self.subTest(status=status):
                self.source_state.routes[("GET", "/summary")] = {
                    "status": status,
                    "reason": "remote reason " + ALICE_KEY,
                    "body": {"error": ALICE_KEY, "url": self.sink_origin + "/" + BOB_KEY},
                    "headers": {"Location": self.sink_origin + "/" + OTHER_KEY},
                }
                stdout, stderr = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    with self.assertRaises(memory.SafeError) as raised:
                        self.execute("summary")
                self.assert_safe(str(raised.exception))
                self.assert_safe("".join(traceback.format_exception(raised.exception)))
                self.assertEqual(stdout.getvalue() + stderr.getvalue(), "")
                self.assertEqual(self.sink_state.requests, [])

    def test_network_exception_and_transport_exception_details_are_suppressed(self):
        transport = memory.Transport()
        with mock.patch.object(transport.opener, "open", side_effect=urllib.error.URLError(ALICE_KEY)):
            with self.assertRaises(memory.SafeError) as raised:
                self.execute("summary", transport=transport)
        self.assert_safe("".join(traceback.format_exception(raised.exception)))
        fake_transport = FakeTransport(exception=RuntimeError(BOB_KEY))
        with self.assertRaises(memory.SafeError) as raised:
            self.execute("summary", transport=fake_transport)
        self.assert_safe("".join(traceback.format_exception(raised.exception)))
        self.assert_no_network()

    def test_response_strings_nested_values_and_object_keys_are_redacted(self):
        self.source_state.routes[("GET", "/summary")] = {
            "body": {
                ALICE_KEY: {"nested " + BOB_KEY: [OTHER_KEY, {"uppercase_other": OTHER_CASE_KEY}]},
                "message": "prefix " + ALICE_KEY + " suffix",
                "count": 3, "present": True, "none": None,
            }
        }
        result = self.execute("summary")
        encoded = json.dumps(result)
        self.assert_safe(encoded)
        self.assertIn("[REDACTED_SPACE_KEY]", encoded)
        self.assertEqual(result["result"]["count"], 3)
        self.assertTrue(result["result"]["present"])
        self.assertIsNone(result["result"]["none"])
        self.assertIn("[REDACTED_SPACE_KEY]", result["result"])

    def test_current_key_full_uppercase_is_redacted_in_strings_nested_values_and_object_keys(self):
        uppercase_key = ALICE_KEY.upper()
        self.source_state.routes[("GET", "/summary")] = {
            "body": {
                "message": "prefix " + uppercase_key + " suffix",
                "nested": [
                    {"message": uppercase_key},
                    {"nested-object:" + uppercase_key: [uppercase_key]},
                ],
                "object:" + uppercase_key: "value preserved",
            }
        }
        result = self.execute("summary")["result"]
        self.assert_safe(json.dumps(result))
        self.assertEqual(result["message"], "prefix [REDACTED_SPACE_KEY] suffix")
        self.assertEqual(result["nested"][0], {"message": "[REDACTED_SPACE_KEY]"})
        self.assertEqual(result["nested"][1], {
            "nested-object:[REDACTED_SPACE_KEY]": ["[REDACTED_SPACE_KEY]"]
        })
        self.assertEqual(result["object:[REDACTED_SPACE_KEY]"], "value preserved")

    def test_execute_redacts_even_an_injected_transport_result(self):
        transport = FakeTransport(result={ALICE_KEY.upper(): [BOB_KEY, {OTHER_KEY: ALICE_KEY.upper()}]})
        result = self.execute("summary", transport=transport)
        self.assert_safe(json.dumps(result))
        self.assert_no_network()

    def test_cross_origin_redirects_are_refused_without_sink_request_or_header(self):
        for code in (300, 301, 302, 303, 307, 308):
            with self.subTest(status=code):
                self.source_state.clear()
                self.sink_state.clear()
                self.source_state.routes[("GET", "/summary")] = {
                    "status": code,
                    "headers": {"Location": self.sink_origin + "/sink?data=" + ALICE_KEY},
                    "body": {"error": BOB_KEY},
                }
                with self.assertRaises(memory.SafeError) as raised:
                    self.execute("summary")
                self.assertIn("Redirect refused", str(raised.exception))
                self.assert_safe("".join(traceback.format_exception(raised.exception)))
                self.assertEqual(len(self.source_state.requests), 1)
                self.assertEqual(self.source_state.requests[0]["headers"]["x-api-key"], ALICE_KEY)
                self.assertEqual(self.sink_state.requests, [])

    def test_same_origin_redirects_are_refused_without_target_request(self):
        for code in (301, 302, 303, 307, 308):
            with self.subTest(status=code):
                self.source_state.clear()
                self.source_state.routes[("GET", "/summary")] = {
                    "status": code, "headers": {"Location": "/sink?data=" + ALICE_KEY}
                }
                with self.assertRaises(memory.SafeError) as raised:
                    self.execute("summary")
                self.assertIn("Redirect refused", str(raised.exception))
                self.assert_safe(str(raised.exception))
                self.assertEqual(len(self.source_state.requests), 1)
                self.assertEqual(self.source_state.requests[0]["path"], "/summary")
                self.assertEqual(self.sink_state.requests, [])

    def test_environment_proxy_cannot_receive_the_authorization_header(self):
        with mock.patch.dict("os.environ", {
            "http_proxy": self.sink_origin, "HTTP_PROXY": self.sink_origin,
            "https_proxy": self.sink_origin, "HTTPS_PROXY": self.sink_origin,
            "no_proxy": "", "NO_PROXY": "",
        }):
            self.execute("summary")
        self.assertEqual(len(self.source_state.requests), 1)
        self.assertEqual(self.sink_state.requests, [])

    def test_invalid_json_and_oversized_response_fail_without_payload_disclosure(self):
        for body in ((ALICE_KEY + " not JSON").encode(), b"x" * (memory.MAX_RESPONSE_BYTES + 1)):
            with self.subTest(size=len(body)):
                self.source_state.routes[("GET", "/summary")] = {"body": body}
                with self.assertRaises(memory.SafeError) as raised:
                    self.execute("summary")
                self.assert_safe(str(raised.exception))

    def test_invalid_search_and_prefix_fail_before_secret_fetch(self):
        for query in ("", "  ", "q\0", "文" * (2048 // 3 + 1)):
            with self.assertRaises(memory.SafeError):
                self.execute("search", query=query)
        for prefix in ("q\0", "文" * (1024 // 3 + 1)):
            with self.assertRaises(memory.SafeError):
                self.execute("list", prefix=prefix)
        self.assertEqual(self.store.get_calls, [])
        self.assert_no_network()

    def test_cli_missing_unknown_user_and_profiles_are_secret_free(self):
        prod_config = self.folder / "production-profiles.json"
        self.write_config(prod_config, self.config_data(memory.PRODUCTION_ORIGIN))
        for argv in (
            ["--config", str(prod_config), "summary"],
            ["--config", str(prod_config), "--user", "unknown-profile", "summary"],
            ["--config", str(prod_config), "profiles"],
        ):
            with self.subTest(command=argv[-1]):
                status, stdout, stderr, store, transport = self.run_cli(argv)
                self.assertEqual(status, 0 if argv[-1] == "profiles" else 2)
                self.assert_safe(stdout + stderr)
                self.assertEqual(store.get_calls, [])
                self.assertEqual(transport.requests, [])
        self.assert_no_network()

    def test_cli_rejects_origin_or_key_arguments_without_echoing_secret(self):
        for argv in (
            ["--user", ALIASES[0], "--origin", self.sink_origin + "/" + ALICE_KEY, "summary"],
            ["--user", ALIASES[0], "--key", ALICE_KEY, "summary"],
            ["--user", ALIASES[0], "--api-key", ALICE_KEY, "summary"],
            ["--user", ALIASES[0], ALICE_KEY],
            ["--user", ALIASES[0], "delete", "entry", "--confirm-target", ALICE_KEY, "--bad", BOB_KEY],
        ):
            with self.subTest(kind="invalid-cli"):
                status, stdout, stderr, store, transport = self.run_cli(argv)
                self.assertEqual(status, 2)
                self.assertEqual(stdout, "")
                self.assert_safe(stderr)
                self.assertEqual(json.loads(stderr), {"error": "Invalid command arguments; run --help."})
                self.assertEqual(store.get_calls, [])
                self.assertEqual(transport.requests, [])
        self.assert_no_network()

    def test_cli_malicious_config_origin_fails_before_secret_access(self):
        self.write_config(self.config, self.config_data(self.sink_origin))
        status, stdout, stderr, store, transport = self.run_cli([
            "--config", str(self.config), "--user", ALIASES[0], "summary"
        ])
        self.assertEqual(status, 2)
        self.assert_safe(stdout + stderr)
        self.assertEqual(store.get_calls, [])
        self.assertEqual(transport.requests, [])
        self.assert_no_network()

    def test_cli_suppresses_fake_store_failure_and_network_exception(self):
        prod_config = self.folder / "production-profiles.json"
        self.write_config(prod_config, self.config_data(memory.PRODUCTION_ORIGIN))
        profiles = memory.load_profiles(prod_config)
        argv = ["--config", str(prod_config), "--user", ALIASES[0], "summary"]
        status, stdout, stderr, _, transport = self.run_cli(
            argv, store=FakeStore(exception=RuntimeError(ALICE_KEY))
        )
        self.assertEqual(status, 2)
        self.assert_safe(stdout + stderr)
        self.assertEqual(transport.requests, [])
        status, stdout, stderr, _, _ = self.run_cli(
            argv, store=self.make_store(profiles),
            transport=FakeTransport(exception=RuntimeError(BOB_KEY))
        )
        self.assertEqual(status, 2)
        self.assert_safe(stdout + stderr)
        self.assert_no_network()

    def test_cli_response_output_is_redacted_with_no_production_network(self):
        prod_config = self.folder / "production-profiles.json"
        self.write_config(prod_config, self.config_data(memory.PRODUCTION_ORIGIN))
        profiles = memory.load_profiles(prod_config)
        transport = FakeTransport(result={ALICE_KEY.upper(): {BOB_KEY: [OTHER_KEY.upper()]}})
        status, stdout, stderr, _, _ = self.run_cli(
            ["--config", str(prod_config), "--user", ALIASES[0], "summary"],
            store=self.make_store(profiles), transport=transport,
        )
        self.assertEqual(status, 0)
        self.assertEqual(stderr, "")
        self.assert_safe(stdout)
        self.assertIn("[REDACTED_SPACE_KEY]", stdout)
        self.assertEqual(len(transport.requests), 1)
        self.assert_no_network()


if __name__ == "__main__":
    unittest.main()
