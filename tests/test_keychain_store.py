"""Mock-only tests: these never load Apple frameworks or access Keychain items."""

import contextlib
import ctypes
import importlib.util
import io
import pathlib
import types
import unittest
from unittest import mock


MODULE_PATH = (
    pathlib.Path(__file__).resolve().parents[1]
    / "skills/walle-memory-profiles/scripts/keychain_store.py"
)


def load_module(name="keychain_store_test"):
    spec = importlib.util.spec_from_file_location(name, MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    with mock.patch("ctypes.CDLL", side_effect=AssertionError("native frameworks forbidden in tests")):
        spec.loader.exec_module(module)
    return module


store = load_module()


class FakeFramework:
    def __init__(self):
        names = (
            "kSecClass", "kSecClassGenericPassword", "kSecAttrService",
            "kSecAttrAccount", "kSecAttrSynchronizable",
            "kSecUseDataProtectionKeychain", "kSecUseAuthenticationUI",
            "kSecUseAuthenticationUIFail", "kSecReturnData", "kSecMatchLimit",
            "kSecMatchLimitOne", "kSecValueData", "kSecMatchSearchList",
            "kSecUseKeychain", "true", "false",
        )
        self.constants = {name: name for name in names}
        self.objects = {}
        self.released = []
        self.calls = []
        self.copy_status = 0
        self.add_status = 0
        self.flags = 7
        self.secret = b"FAKE-key-for-mocked-framework-only"
        self.read_error = None
        self.release_error = None
        self.default = self._allocate("mock default file keychain")

    def _allocate(self, value):
        reference = len(self.objects) + 1
        self.objects[reference] = value
        return reference

    def disable_interaction(self):
        self.calls.append(("disable_ui",))

    def copy_default(self):
        self.calls.append(("default",))
        return 0, self.default

    def keychain_status(self, keychain):
        self.calls.append(("status", keychain))
        return 0, self.flags

    def make_array(self, values):
        return self._allocate(values)

    def make_string(self, value):
        return self._allocate(value)

    def make_data(self, value):
        return self._allocate(value)

    def make_dictionary(self, pairs):
        result = self._allocate(dict(pairs))
        self.last_query = self.objects[result]
        return result

    def copy_matching(self, query):
        self.calls.append(("copy", query))
        # A result is deliberately returned even on failure to test cleanup.
        return self.copy_status, self._allocate(self.secret)

    def add_item(self, query):
        self.calls.append(("add", query))
        return self.add_status

    def data_bytes(self, result):
        if self.read_error:
            raise self.read_error
        return self.objects[result]

    def release(self, reference):
        self.released.append(reference)
        if self.release_error:
            raise self.release_error


class KeychainAdapterTests(unittest.TestCase):
    def setUp(self):
        self.framework = FakeFramework()
        self.keychain = store.MacOSKeychain()
        self.keychain._api = self.framework

    def assert_all_owned_released(self):
        self.assertEqual(
            self.framework.released,
            list(reversed(list(self.framework.objects))),
        )

    def test_import_and_construction_do_not_load_frameworks(self):
        with mock.patch("ctypes.CDLL", side_effect=AssertionError("must not load")) as cdll:
            imported = load_module("keychain_store_import_check")
            imported.MacOSKeychain()
        cdll.assert_not_called()

    def test_exact_profile_reference_and_single_keychain(self):
        value = self.keychain.get("example.invalid/profile-service", "alice")
        self.assertEqual(value, self.framework.secret.decode("ascii"))
        query = self.framework.last_query
        self.assertEqual(self.framework.objects[query["kSecAttrService"]], "example.invalid/profile-service")
        self.assertEqual(self.framework.objects[query["kSecAttrAccount"]], "alice")
        self.assertEqual(self.framework.objects[query["kSecMatchSearchList"]], [self.framework.default])
        self.assertEqual(query["kSecClass"], "kSecClassGenericPassword")
        self.assertEqual(query["kSecMatchLimit"], "kSecMatchLimitOne")
        self.assertNotIn("kSecAttrSynchronizable", query)
        self.assertEqual(query["kSecUseDataProtectionKeychain"], "false")
        self.assertNotIn("kSecUseAuthenticationUI", query)
        self.assertEqual(self.framework.calls[0], ("disable_ui",))
        self.assertEqual(sum(call[0] == "copy" for call in self.framework.calls), 1)
        self.assert_all_owned_released()

    def test_add_is_local_add_only_and_never_reads_old_item(self):
        self.keychain.add("example.invalid/profile-service", "bob", "FAKE-new-key")
        query = self.framework.last_query
        self.assertEqual(query["kSecUseKeychain"], self.framework.default)
        self.assertEqual(query["kSecAttrSynchronizable"], "false")
        self.assertEqual(query["kSecUseDataProtectionKeychain"], "false")
        self.assertNotIn("kSecAttrAccessible", query)
        self.assertEqual(self.framework.objects[query["kSecAttrAccount"]], "bob")
        self.assertEqual(self.framework.objects[query["kSecValueData"]], b"FAKE-new-key")
        self.assertEqual(sum(call[0] == "add" for call in self.framework.calls), 1)
        self.assertFalse(any(call[0] == "copy" for call in self.framework.calls))
        self.assert_all_owned_released()

    def test_duplicate_add_fails_without_read_replace_or_delete(self):
        self.framework.add_status = store._DUPLICATE_ITEM
        with self.assertRaises(store.KeychainExists) as raised:
            self.keychain.add("service", "bob", "FAKE-new-key")
        self.assertEqual(str(raised.exception), store._EXISTS)
        self.assertEqual([call[0] for call in self.framework.calls], ["disable_ui", "default", "status", "add"])
        self.assert_all_owned_released()

    def test_locked_keychain_fails_before_any_item_operation(self):
        self.framework.flags = 6
        with self.assertRaises(store.KeychainError) as raised:
            self.keychain.get("service", "alice")
        self.assertEqual(str(raised.exception), store._ACCESS_DENIED)
        self.assertEqual([call[0] for call in self.framework.calls], ["disable_ui", "default", "status"])
        self.assertEqual(self.framework.released, [self.framework.default])

    def test_missing_denied_and_unknown_status_fail_with_fixed_messages(self):
        statuses = (
            (store._ITEM_NOT_FOUND, store._MISSING),
            (store._AUTH_FAILED, store._ACCESS_DENIED),
            (store._INTERACTION_NOT_ALLOWED, store._ACCESS_DENIED),
            (store._MISSING_ENTITLEMENT, store._ENTITLEMENT),
            (-999987, store._OPERATION_FAILED),
        )
        for status, message in statuses:
            with self.subTest(status=status):
                self.setUp()
                self.framework.copy_status = status
                with self.assertRaises(store.KeychainError) as raised:
                    self.keychain.get("service", "alice")
                self.assertEqual(str(raised.exception), message)
                self.assertNotIn(str(status), str(raised.exception))
                self.assert_all_owned_released()

    def test_unexpected_framework_error_and_output_are_redacted(self):
        fake_secret = "FAKE-sensitive-string-from-native-error"
        self.framework.read_error = RuntimeError(fake_secret)
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            with self.assertRaises(store.KeychainError) as raised:
                self.keychain.get("service", "alice")
        self.assertEqual(str(raised.exception), store._OPERATION_FAILED)
        self.assertTrue(raised.exception.__suppress_context__)
        self.assertNotIn(fake_secret, str(raised.exception))
        self.assertEqual(output.getvalue(), "")
        self.assert_all_owned_released()

    def test_cleanup_failure_is_redacted_and_attempts_all_releases(self):
        self.framework.release_error = RuntimeError("FAKE-sensitive-release-error")
        with self.assertRaises(store.KeychainError) as raised:
            self.keychain.get("service", "alice")
        self.assertEqual(str(raised.exception), store._OPERATION_FAILED)
        self.assert_all_owned_released()

    def test_missing_native_framework_has_fixed_error(self):
        keychain = store.MacOSKeychain()
        with mock.patch.object(store, "_load_native", side_effect=OSError("FAKE-sensitive-library-error")):
            with self.assertRaises(store.KeychainError) as raised:
                keychain.get("service", "alice")
        self.assertEqual(str(raised.exception), store._OPERATION_FAILED)

    def test_bad_references_and_secrets_fail_before_native_loading(self):
        keychain = store.MacOSKeychain()
        with mock.patch.object(store, "_load_native", side_effect=AssertionError("no native load")) as native:
            for service, account in (("", "alice"), ("service", ""), ("service\0", "alice"), ("service", "a\n")):
                with self.subTest(service=service, account=account), self.assertRaises(store.KeychainError):
                    keychain.get(service, account)
            for secret in ("", "x" * 513, "FAKE\r\nkey", "FAKEékey", None):
                with self.subTest(secret=secret), self.assertRaises(store.KeychainError) as raised:
                    keychain.add("service", "alice", secret)
                self.assertEqual(str(raised.exception), store._BAD_SECRET)
            native.assert_not_called()

    def test_corrupt_stored_data_fails_and_releases_all_refs(self):
        for value in (b"", b"x" * 513, b"FAKE\nkey", b"FAKE\xffkey"):
            with self.subTest(value=value):
                self.setUp()
                self.framework.secret = value
                with self.assertRaises(store.KeychainError) as raised:
                    self.keychain.get("service", "alice")
                self.assertEqual(str(raised.exception), store._BAD_SECRET)
                self.assert_all_owned_released()

    def test_ui_disable_failure_prevents_any_keychain_access(self):
        self.framework.disable_interaction = mock.Mock(side_effect=RuntimeError("FAKE-sensitive-error"))
        with self.assertRaises(store.KeychainError) as raised:
            self.keychain.get("service", "alice")
        self.assertEqual(str(raised.exception), store._OPERATION_FAILED)
        self.assertEqual(self.framework.calls, [])
        self.assertEqual(self.framework.released, [])


class MockNativeBindingTests(unittest.TestCase):
    def test_native_add_never_requests_a_returned_object(self):
        native = store._NativeAPI.__new__(store._NativeAPI)
        add = mock.Mock(return_value=0)
        native.security = types.SimpleNamespace(SecItemAdd=add)
        self.assertEqual(native.add_item(101), 0)
        add.assert_called_once_with(101, None)

    def test_native_ui_switch_only_passes_false(self):
        native = store._NativeAPI.__new__(store._NativeAPI)
        switch = mock.Mock(return_value=0)
        native.security = types.SimpleNamespace(SecKeychainSetUserInteractionAllowed=switch)
        native.disable_interaction()
        switch.assert_called_once_with(False)

    def test_native_copy_result_pointer_is_returned_for_cleanup(self):
        native = store._NativeAPI.__new__(store._NativeAPI)
        def copy(query, result):
            ctypes.cast(result, ctypes.POINTER(ctypes.c_void_p))[0] = ctypes.c_void_p(202)
            return -25308
        native.security = types.SimpleNamespace(SecItemCopyMatching=copy)
        self.assertEqual(native.copy_matching(101), (-25308, 202))

    def test_native_data_checks_type_and_length_before_dereferencing(self):
        for type_id, length in ((99, 2), (10, -1), (10, 513)):
            with self.subTest(type_id=type_id, length=length):
                native = store._NativeAPI.__new__(store._NativeAPI)
                dereference = mock.Mock(side_effect=AssertionError("must not dereference"))
                native.cf = types.SimpleNamespace(
                    CFGetTypeID=lambda _: type_id,
                    CFDataGetTypeID=lambda: 10,
                    CFDataGetLength=lambda _: length,
                    CFDataGetBytePtr=dereference,
                )
                with self.assertRaises(store.KeychainError):
                    native.data_bytes(101)
                dereference.assert_not_called()

    def test_native_data_reads_only_bounded_data(self):
        native = store._NativeAPI.__new__(store._NativeAPI)
        buffer = (ctypes.c_ubyte * 8).from_buffer_copy(b"FAKE-key")
        native.cf = types.SimpleNamespace(
            CFGetTypeID=lambda _: 10,
            CFDataGetTypeID=lambda: 10,
            CFDataGetLength=lambda _: 8,
            CFDataGetBytePtr=lambda _: ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)),
        )
        self.assertEqual(native.data_bytes(101), b"FAKE-key")

    def test_native_make_data_zeroes_temporary_buffer(self):
        native = store._NativeAPI.__new__(store._NativeAPI)
        captured = []
        def create(allocator, buffer, length):
            self.assertEqual(bytes(buffer), b"FAKE-key")
            captured.append(buffer)
            return 101
        native.cf = types.SimpleNamespace(CFDataCreate=create)
        self.assertEqual(native.make_data(b"FAKE-key"), 101)
        self.assertEqual(bytes(captured[0]), b"\0" * 8)


if __name__ == "__main__":
    unittest.main()
